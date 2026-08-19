import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const NOFOLLOW = constants.O_NOFOLLOW;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const DISABLED_MODEL_API_KEY_FILE = '/dev/null';
const NON_OWNER_MODEL_API_KEY_MODE = 0o077;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function absolutePath(value) {
  const normalized = nonEmptyString(value);
  return normalized && path.isAbsolute(normalized) ? path.resolve(normalized) : null;
}

function configuredModelApiKeyFile(environment = process.env) {
  // Explicit configuration is authoritative, including an invalid value. Do
  // not silently fall through to a different profile when a caller supplied
  // an empty or relative credential path.
  for (const name of ['CODEX_CO_ENGINEER_MODEL_API_KEY_FILE', 'PLUMBOB_HARNESS_MODEL_API_KEY_FILE']) {
    if (Object.prototype.hasOwnProperty.call(environment, name)) {
      return absolutePath(environment[name]) ?? DISABLED_MODEL_API_KEY_FILE;
    }
  }

  if (Object.prototype.hasOwnProperty.call(environment, 'XDG_CONFIG_HOME')) {
    const configRoot = absolutePath(environment.XDG_CONFIG_HOME);
    return configRoot
      ? path.join(configRoot, 'codex-co-engineer', 'model-api-key')
      : DISABLED_MODEL_API_KEY_FILE;
  }

  const home = absolutePath(environment.HOME);
  return home
    ? path.join(home, '.config', 'codex-co-engineer', 'model-api-key')
    : DISABLED_MODEL_API_KEY_FILE;
}

export const MODEL_API_KEY_FILE = configuredModelApiKeyFile();

const inheritedModelApiKey = process.env.MODEL_API_KEY?.trim() || '';

const MODEL_API_KEY_BINDING_SCHEMA = 'codex-co-engineer.model-api-key-binding.v1';

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertProtectedModelApiKeyMetadata(metadata) {
  const uid = currentUid();
  if (uid === null || !metadata.isFile() || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || (metadata.mode & NON_OWNER_MODEL_API_KEY_MODE) !== 0
    || metadata.nlink !== 1) {
    throw new Error('model API key file is not an owner-only, singly-linked regular file');
  }
}

async function assertNoSymlinkAncestors(file) {
  const parsed = path.parse(file);
  let component = parsed.root;
  const ancestors = file.slice(parsed.root.length).split(path.sep).filter(Boolean).slice(0, -1);
  for (const name of ancestors) {
    component = path.join(component, name);
    const metadata = await lstat(component);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('model API key path contains an unsafe ancestor');
    }
  }
}

async function readProtectedModelApiKey(file) {
  if (!NOFOLLOW || typeof file !== 'string' || !path.isAbsolute(file)) {
    throw new Error('model API key file cannot be securely opened');
  }

  let handle;
  try {
    // O_NOFOLLOW prevents a final-component symlink from redirecting a
    // credential read. The descriptor is then checked and used for the read,
    // avoiding a path-based stat/read race.
    await assertNoSymlinkAncestors(file);
    // The lstat preflight avoids opening a FIFO in blocking read mode. The
    // descriptor check below remains authoritative if the path is replaced
    // between this preflight and open().
    assertProtectedModelApiKeyMetadata(await lstat(file));
    handle = await open(file, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const metadata = await handle.stat();
    assertProtectedModelApiKeyMetadata(metadata);
    const key = (await handle.readFile('utf8')).trim();
    if (!key || /[\u0000-\u001f\u007f\s]/.test(key)) throw new Error('invalid key file');
    return key;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function metadataIdentity(metadata) {
  return {
    type: metadata.isFile()
      ? 'file'
      : metadata.isDirectory()
        ? 'directory'
        : metadata.isSymbolicLink()
          ? 'symbolic-link'
          : 'other',
    device: String(metadata.dev),
    inode: String(metadata.ino),
    mode: String(metadata.mode),
    uid: String(metadata.uid),
    gid: String(metadata.gid),
    size: String(metadata.size),
    links: String(metadata.nlink),
    modified_ns: String(metadata.mtimeNs),
    changed_ns: String(metadata.ctimeNs),
  };
}

/**
 * Return a non-secret identity for the configured credential binding.
 *
 * This intentionally uses only canonical path and filesystem metadata. It
 * must never read the key file contents: the digest exists solely to prevent
 * an MCP process from reusing a daemon launched with a different binding.
 */
export async function modelApiKeyBindingDigest(file = MODEL_API_KEY_FILE) {
  const configuredPath = typeof file === 'string' && file.length > 0
    ? path.resolve(file)
    : String(file ?? '');
  let canonicalPath = configuredPath;
  let realpathError = null;
  if (canonicalPath) {
    try {
      canonicalPath = await realpath(canonicalPath);
    } catch (error) {
      realpathError = error?.code ?? 'realpath_failed';
    }
  }

  let metadata;
  try {
    metadata = metadataIdentity(await lstat(canonicalPath, { bigint: true }));
  } catch (error) {
    metadata = { error: error?.code ?? 'stat_failed' };
  }

  return createHash('sha256')
    .update(JSON.stringify({
      schema: MODEL_API_KEY_BINDING_SCHEMA,
      configured_path: configuredPath,
      canonical_path: canonicalPath,
      realpath_error: realpathError,
      metadata,
    }))
    .digest('hex');
}

export async function loadModelApiKey(file = MODEL_API_KEY_FILE) {
  if (inheritedModelApiKey) {
    process.env.MODEL_API_KEY = inheritedModelApiKey;
    return { available: true, source: 'environment' };
  }

  try {
    const key = await readProtectedModelApiKey(file);
    process.env.MODEL_API_KEY = key;
    return { available: true, source: 'protected_file' };
  } catch {
    delete process.env.MODEL_API_KEY;
    return { available: false, source: null };
  }
}
