import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CursorApiError, DEFAULT_MAX_ARTIFACT_BYTES } from './client.mjs';
import { assertSafeRelativeDestination } from './validation.mjs';

function rootFromEnvironment(env = process.env) {
  const value = typeof env.CURSOR_ARTIFACT_ROOT === 'string' ? env.CURSOR_ARTIFACT_ROOT.trim() : '';
  if (!value || !path.isAbsolute(value)) throw new CursorApiError('artifact_root_missing', 'CURSOR_ARTIFACT_ROOT must be an administrator-configured absolute directory.');
  return path.resolve(value);
}

async function safeRoot(env) {
  const root = rootFromEnvironment(env);
  let metadata;
  try { metadata = await lstat(root); } catch { throw new CursorApiError('artifact_root_missing', 'CURSOR_ARTIFACT_ROOT does not exist.'); }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new CursorApiError('artifact_root_unsafe', 'CURSOR_ARTIFACT_ROOT must be a real directory.');
  return realpath(root);
}

async function ensureParents(root, relative) {
  const parts = relative.split('/');
  parts.pop();
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new CursorApiError('unsafe_destination', 'Artifact destination traverses a symlink or non-directory.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 });
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new CursorApiError('unsafe_destination', 'Artifact destination parent is unsafe.');
    }
  }
}

export async function saveArtifact(bytes, destination, { env = process.env, overwrite = false } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new CursorApiError('artifact_download_failed', 'Artifact download did not return bytes.');
  const root = await safeRoot(env);
  const relative = assertSafeRelativeDestination(destination);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new CursorApiError('unsafe_destination', 'Artifact destination escapes the configured root.');
  await ensureParents(root, relative);
  try {
    const existing = await lstat(absolute);
    if (existing.isSymbolicLink()) throw new CursorApiError('unsafe_destination', 'Artifact destination is a symlink.');
    if (existing.isDirectory()) throw new CursorApiError('unsafe_destination', 'Artifact destination is a directory.');
    if (!overwrite) throw new CursorApiError('destination_exists', 'Artifact destination exists; pass overwrite=true to replace it.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.part`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    if (overwrite) {
      await rename(temporary, absolute);
    } else {
      // A hard link gives the default no-overwrite behavior an atomic
      // EEXIST barrier instead of relying on the earlier lstat check.
      await link(temporary, absolute);
      await unlink(temporary);
    }
    await chmod(absolute, 0o600).catch(() => {});
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (error?.code === 'EEXIST') throw new CursorApiError('destination_exists', 'Artifact destination exists; pass overwrite=true to replace it.');
    throw new CursorApiError('artifact_write_failed', 'Artifact could not be written safely.');
  }
  return { path: absolute, relativePath: relative, bytes: bytes.byteLength, mode: 'owner-only' };
}

export function maxArtifactBytes(env = process.env) {
  const value = env.CURSOR_CLOUD_CONTROL_MAX_ARTIFACT_BYTES;
  if (value === undefined || value === '') return DEFAULT_MAX_ARTIFACT_BYTES;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 100 * 1024 * 1024) throw new CursorApiError('invalid_configuration', 'CURSOR_CLOUD_CONTROL_MAX_ARTIFACT_BYTES must be between 1024 and 104857600.');
  return parsed;
}
