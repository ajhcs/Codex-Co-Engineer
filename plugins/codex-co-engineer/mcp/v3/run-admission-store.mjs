// Private, additive persistence for 3.4.1 simple-run coordination.
//
// The legacy run store remains the authority for 3.4.0 full envelopes. This
// store keeps the compiled request and lifecycle record under a separate
// owner-only directory so a server restart can observe the same run without
// rewriting or migrating existing receipts.

import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { assertRunId, isAssignmentId } from './run-manifest.mjs';
import { compactOwnedCorrectionFollowV1 } from './owned-delegation.mjs';
import { assertDirectJsonClosure } from './selection-json.mjs';

export const RUN_ADMISSION_STORE_SCHEMA = 'codex-co-engineer.run-admission-store.v1';
export const RUN_ADMISSION_STORE_DIRECTORY = 'runs-3.4.1';
export const RUN_ADMISSION_STORE_MAX_BYTES = 512 * 1024;

const ROOT_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_DIRECTORY ?? 0)
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_NONBLOCK ?? 0);
const READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_NONBLOCK ?? 0);
const WRITE_FLAGS = fsConstants.O_WRONLY
  | fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | (fsConstants.O_NOFOLLOW ?? 0);
const RUN_ID = /^[a-z][a-z0-9-]{2,63}$/u;
const HEX = /^[0-9a-f]{64}$/u;

function storeError(code, message) {
  throw Object.assign(new Error(message), { code });
}

function safeRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || value.includes('\0')) {
    storeError('run_store_path_unsafe', 'The run admission store root must be a normalized absolute path.');
  }
  return value;
}

function safeRunId(value) {
  try {
    assertRunId(value, 'run_id');
  } catch {
    storeError('run_store_identity_invalid', 'The run admission store run id is invalid.');
  }
  if (!RUN_ID.test(value)) storeError('run_store_identity_invalid', 'The run admission store run id is invalid.');
  return value;
}

function fileName(runId) {
  return `${safeRunId(runId)}.json`;
}

function ownerUid() {
  return typeof process.geteuid === 'function' ? process.geteuid() : undefined;
}

function assertPrivateDirectory(metadata, code = 'run_store_root_unsafe') {
  if (metadata.isSymbolicLink?.() || !metadata.isDirectory?.()) storeError(code, 'The run admission store directory is not a real private directory.');
  const uid = ownerUid();
  if (uid !== undefined && Number(metadata.uid) !== uid) storeError(code, 'The run admission store directory has the wrong owner.');
  if ((metadata.mode & 0o077) !== 0) storeError(code, 'The run admission store directory is not owner-only.');
}

function assertPrivateFile(metadata) {
  if (metadata.isSymbolicLink?.() || !metadata.isFile?.() || Number(metadata.nlink) !== 1) {
    storeError('run_store_record_unsafe', 'The run admission store record is not a private regular file.');
  }
  const uid = ownerUid();
  if (uid !== undefined && Number(metadata.uid) !== uid) storeError('run_store_record_unsafe', 'The run admission store record has the wrong owner.');
  if ((metadata.mode & 0o077) !== 0) storeError('run_store_record_unsafe', 'The run admission store record is not owner-only.');
}

async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const metadata = await lstat(directory);
  assertPrivateDirectory(metadata);
  return metadata;
}

async function openRoot(directory) {
  let handle;
  try {
    handle = await open(directory, ROOT_FLAGS);
  } catch (error) {
    storeError('run_store_root_unsafe', `The run admission store directory could not be opened (${error?.code ?? 'unknown'}).`);
  }
  try {
    const metadata = await handle.stat();
    assertPrivateDirectory(metadata);
    return { handle, metadata };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function canonicalRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    storeError('run_store_record_invalid', 'The run admission record must be a JSON object.');
  }
  let plain;
  try {
    // The compiled request intentionally shares immutable identity objects
    // between its public and child views. Persistence stores a JSON tree, so
    // de-alias before applying the strict on-disk closure checks.
    plain = JSON.parse(JSON.stringify(record));
  } catch {
    storeError('run_store_record_invalid', 'The run admission record is not serializable JSON.');
  }
  assertDirectJsonClosure(plain, 'run_record');
  if (plain.schema !== 'codex-co-engineer.run-admission.v1' || typeof plain.run_id !== 'string') {
    storeError('run_store_record_invalid', 'The run admission record identity is invalid.');
  }
  safeRunId(plain.run_id);
  const serialized = JSON.stringify(plain);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > RUN_ADMISSION_STORE_MAX_BYTES) {
    storeError('run_store_record_too_large', 'The run admission record exceeds its private size bound.');
  }
  return `${serialized}\n`;
}

function parseRecord(text, runId) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    storeError('run_store_record_invalid', 'The run admission record is not valid JSON.');
  }
  canonicalRecord(record);
  if (record.run_id !== runId) storeError('run_store_identity_mismatch', 'The run admission record belongs to another run.');
  return record;
}

export function createRunAdmissionStore(root) {
  const stateRoot = safeRoot(root);
  const directory = path.join(stateRoot, RUN_ADMISSION_STORE_DIRECTORY);
  let ready;
  const initialize = async () => {
    ready ??= ensureDirectory(directory);
    await ready;
  };

  async function load(runId) {
    const name = fileName(runId);
    await initialize();
    const rootHandle = await openRoot(directory);
    const target = path.join(directory, name);
    try {
      let handle;
      try {
        handle = await open(target, READ_FLAGS);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        storeError('run_store_record_unsafe', 'The run admission record could not be opened safely.');
      }
      try {
        const metadata = await handle.stat();
        assertPrivateFile(metadata);
        if (Number(metadata.size) > RUN_ADMISSION_STORE_MAX_BYTES) {
          storeError('run_store_record_too_large', 'The run admission record exceeds its private size bound.');
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (Number(after.ino) !== Number(metadata.ino) || Number(after.size) !== Number(metadata.size)) {
          storeError('run_store_record_changed', 'The run admission record changed while it was read.');
        }
        return parseRecord(bytes.toString('utf8'), runId);
      } finally {
        await handle.close().catch(() => {});
      }
    } finally {
      await rootHandle.handle.close().catch(() => {});
    }
  }

  async function save(record) {
    const runId = safeRunId(record?.run_id);
    const text = canonicalRecord(record);
    await initialize();
    const rootHandle = await openRoot(directory);
    const name = fileName(runId);
    const temporaryName = `.tmp-${randomUUID()}.json`;
    const temporary = path.join(directory, temporaryName);
    const target = path.join(directory, name);
    try {
      try {
        const existing = await lstat(target);
        if (existing.isSymbolicLink?.()) storeError('run_store_record_unsafe', 'The run admission record target is a symbolic link.');
        assertPrivateFile(existing);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const handle = await open(temporary, WRITE_FLAGS, 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }
      await rename(temporary, target);
      await rootHandle.handle.sync().catch(() => {});
    } finally {
      await rootHandle.handle.close().catch(() => {});
      // A failed write may leave only our uniquely named temporary behind.
      // Do not unlink arbitrary paths or a caller-selected target here.
      try {
        const leftover = await lstat(temporary);
        if (leftover.isFile?.() && !leftover.isSymbolicLink?.()) {
          await unlink(temporary);
        }
      } catch {
        // No temporary or an unsafe replacement is left for the next
        // fail-closed store inspection.
      }
    }
  }

  // Exclusive durable reservation before child admission. A second MCP process
  // may inspect the same child, but cannot dispatch a competing correction.
  // A crash before child persistence leaves a pending reservation: do not
  // automatically reclaim it or assume the provider did no work.
  async function reserveRevision(producerRunId, assignmentId, followInput) {
    safeRunId(producerRunId);
    if (!isAssignmentId(assignmentId)) storeError('run_store_identity_invalid', 'Invalid correction assignment.');
    const follow = compactOwnedCorrectionFollowV1(followInput);
    const target = path.join(directory, `${producerRunId}.${assignmentId}.revision.json`);
    const schema = 'codex-co-engineer.owned-revision-reservation.v1';
    const reservationId = randomUUID();
    await initialize();
    const rootHandle = await openRoot(directory);
    let handle;
    try {
      try {
        handle = await open(target, WRITE_FLAGS, 0o600);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await open(target, READ_FLAGS);
        try {
          const metadata = await existing.stat();
          assertPrivateFile(metadata);
          if (metadata.size > 2048) storeError('run_store_record_too_large', 'Correction reservation exceeds its bound.');
          let record;
          try { record = JSON.parse(await existing.readFile('utf8')); } catch {
            storeError('revision_admission_pending', 'Correction reservation is pending; inspect before retrying.');
          }
          if (record?.schema !== schema || record.producer_run_id !== producerRunId
            || record.assignment_id !== assignmentId || typeof record.reservation_id !== 'string') {
            storeError('run_store_identity_mismatch', 'Correction reservation identity differs.');
          }
          return { reserved: false, follow: compactOwnedCorrectionFollowV1(record.follow) };
        } finally {
          await existing.close();
        }
      }
      const text = JSON.stringify({ schema, producer_run_id: producerRunId,
        assignment_id: assignmentId, reservation_id: reservationId, follow });
      await handle.chmod(0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      const written = await handle.stat();
      assertPrivateFile(written);
      await rootHandle.handle.sync();
      return {
        reserved: true,
        follow,
        // Only the winning caller can release its own pre-admission failure.
        // An admitted child, including failed work, permanently consumes it.
        release: async () => {
          const existing = await open(target, READ_FLAGS);
          try {
            const metadata = await existing.stat();
            assertPrivateFile(metadata);
            if (metadata.ino !== written.ino || metadata.dev !== written.dev) {
              storeError('run_store_record_changed', 'Correction reservation changed.');
            }
            const record = JSON.parse(await existing.readFile('utf8'));
            if (record.reservation_id !== reservationId) storeError('run_store_record_changed', 'Correction reservation changed.');
            await unlink(target);
          } finally {
            await existing.close();
          }
        },
      };
    } finally {
      await handle?.close().catch(() => {});
      await rootHandle.handle.close().catch(() => {});
    }
  }

  async function has(runId) {
    return (await load(runId)) !== null;
  }

  return Object.freeze({ directory, load, save, has, reserveRevision });
}
