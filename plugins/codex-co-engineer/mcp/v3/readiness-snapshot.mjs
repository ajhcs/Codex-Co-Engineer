// Owner-only, content-free readiness snapshot for the 3.4.1 status path.
// This is a cache hint, never dispatch authority: an admission still performs
// its own provider, boundary, and repository checks before sending prompts.

import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, lstat } from 'node:fs/promises';
import path from 'node:path';

import { assertDirectJsonClosure } from './selection-json.mjs';

export const READINESS_SNAPSHOT_SCHEMA = 'codex-co-engineer.readiness-snapshot.v1';
export const READINESS_SNAPSHOT_FILE = 'readiness-3.4.1.json';
export const READINESS_SNAPSHOT_MAX_BYTES = 64 * 1024;

const ROOT_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_DIRECTORY ?? 0)
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_NONBLOCK ?? 0);

function unsafe(code, message) {
  throw Object.assign(new Error(message), { code });
}

function normalizeRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || root.includes('\0')) {
    unsafe('readiness_snapshot_path_unsafe', 'The readiness snapshot root must be a normalized absolute path.');
  }
  return root;
}

function assertPrivateDirectory(metadata) {
  if (metadata.isSymbolicLink?.() || !metadata.isDirectory?.()
    || (metadata.mode & 0o077) !== 0) {
    unsafe('readiness_snapshot_root_unsafe', 'The readiness snapshot root is not a private directory.');
  }
  if (typeof process.geteuid === 'function' && Number(metadata.uid) !== process.geteuid()) {
    unsafe('readiness_snapshot_root_unsafe', 'The readiness snapshot root has the wrong owner.');
  }
}

async function ensureRoot(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const metadata = await lstat(root);
  assertPrivateDirectory(metadata);
}

function snapshotPath(root) {
  return path.join(normalizeRoot(root), READINESS_SNAPSHOT_FILE);
}

function canonicalSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== READINESS_SNAPSHOT_SCHEMA
    || value.version !== 1
    || typeof value.observed_at !== 'string'
    || !Number.isFinite(Date.parse(value.observed_at))
    || !value.readiness || typeof value.readiness !== 'object'
    || Array.isArray(value.readiness)) {
    unsafe('readiness_snapshot_invalid', 'The readiness snapshot is invalid.');
  }
  try {
    assertDirectJsonClosure(value, 'readiness_snapshot');
  } catch {
    unsafe('readiness_snapshot_invalid', 'The readiness snapshot is not direct JSON.');
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > READINESS_SNAPSHOT_MAX_BYTES) {
    unsafe('readiness_snapshot_too_large', 'The readiness snapshot exceeds its size bound.');
  }
  return `${serialized}\n`;
}

export async function loadReadinessSnapshot(root) {
  const target = snapshotPath(root);
  try {
    await ensureRoot(root);
    const rootHandle = await open(root, ROOT_FLAGS);
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink?.() || !metadata.isFile?.()
        || Number(metadata.nlink) !== 1 || (metadata.mode & 0o077) !== 0
        || (typeof process.geteuid === 'function' && Number(metadata.uid) !== process.geteuid())) {
        unsafe('readiness_snapshot_unsafe', 'The readiness snapshot is not a private regular file.');
      }
      if (Number(metadata.size) > READINESS_SNAPSHOT_MAX_BYTES) {
        unsafe('readiness_snapshot_too_large', 'The readiness snapshot exceeds its size bound.');
      }
      const handle = await open(target, fsConstants.O_RDONLY
        | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
      try {
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (Number(after.ino) !== Number(metadata.ino) || Number(after.size) !== Number(metadata.size)) {
          unsafe('readiness_snapshot_changed', 'The readiness snapshot changed while it was read.');
        }
        const parsed = JSON.parse(bytes.toString('utf8'));
        canonicalSnapshot(parsed);
        return {
          observed_at: parsed.observed_at,
          readiness: parsed.readiness,
          probe_duration_ms: parsed.probe_duration_ms ?? null,
        };
      } finally {
        await handle.close().catch(() => {});
      }
    } finally {
      await rootHandle.close().catch(() => {});
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code?.startsWith?.('readiness_snapshot_')) return null;
    return null;
  }
}

export async function saveReadinessSnapshot(root, readiness, { observed_at, probe_duration_ms } = {}) {
  const normalizedRoot = normalizeRoot(root);
  await ensureRoot(normalizedRoot);
  const value = {
    schema: READINESS_SNAPSHOT_SCHEMA,
    version: 1,
    observed_at: typeof observed_at === 'string' ? observed_at : new Date().toISOString(),
    readiness,
    ...(Number.isSafeInteger(probe_duration_ms) && probe_duration_ms >= 0
      ? { probe_duration_ms } : {}),
  };
  const text = canonicalSnapshot(value);
  const rootHandle = await open(normalizedRoot, ROOT_FLAGS);
  const temporary = path.join(normalizedRoot, `.tmp-readiness-${randomUUID()}.json`);
  const target = snapshotPath(normalizedRoot);
  try {
    const handle = await open(temporary, fsConstants.O_WRONLY
      | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    await rename(temporary, target);
    await rootHandle.sync().catch(() => {});
  } finally {
    await rootHandle.close().catch(() => {});
  }
}
