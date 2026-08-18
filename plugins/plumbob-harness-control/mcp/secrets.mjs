import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const configRoot = process.env.XDG_CONFIG_HOME
  ?? path.join(process.env.HOME ?? '', '.config');

export const MODEL_API_KEY_FILE = process.env.CODEX_CO_ENGINEER_MODEL_API_KEY_FILE
  ?? process.env.PLUMBOB_HARNESS_MODEL_API_KEY_FILE
  ?? path.join(configRoot, 'codex-co-engineer', 'model-api-key');

const inheritedModelApiKey = process.env.MODEL_API_KEY?.trim() || '';

const MODEL_API_KEY_BINDING_SCHEMA = 'codex-co-engineer.model-api-key-binding.v1';

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

export async function loadModelApiKey() {
  if (inheritedModelApiKey) {
    process.env.MODEL_API_KEY = inheritedModelApiKey;
    return { available: true, source: 'environment' };
  }

  try {
    const key = (await readFile(MODEL_API_KEY_FILE, 'utf8')).trim();
    if (!key || /[\u0000-\u001f\u007f\s]/.test(key)) throw new Error('invalid key file');
    process.env.MODEL_API_KEY = key;
    return { available: true, source: 'protected_file' };
  } catch {
    delete process.env.MODEL_API_KEY;
    return { available: false, source: null };
  }
}
