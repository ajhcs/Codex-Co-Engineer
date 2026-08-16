import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CursorApiError } from './client.mjs';

const MAX_RECORDS = 500;

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite value cannot be digested.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  throw new TypeError(`Unsupported digest value: ${typeof value}`);
}

export function requestDigest(kind, value) {
  return createHash('sha256').update(JSON.stringify({ kind, value: canonical(value) })).digest('hex');
}

function now() { return new Date().toISOString(); }

export class SubmissionLedger {
  constructor({ stateDir } = {}) {
    this.stateDir = path.resolve(stateDir ?? process.env.CURSOR_CLOUD_CONTROL_STATE_DIR ?? path.join(process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? '.', '.local', 'state'), 'cursor-cloud-control'));
    this.file = path.join(this.stateDir, 'submissions.json');
    this.records = new Map();
    this.loaded = false;
  }

  async init() {
    if (this.loaded) return;
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(this.stateDir);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new CursorApiError('ledger_permissions', 'Submission ledger directory must be a real directory.');
    }
    await chmod(this.stateDir, 0o700).catch(() => {});
    try {
      const metadata = await stat(this.file);
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new CursorApiError('ledger_permissions', 'Submission ledger must be an owner-only regular file.');
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (parsed && Array.isArray(parsed.records)) {
        for (const record of parsed.records.slice(-MAX_RECORDS)) {
          if (typeof record?.requestId === 'string' && typeof record?.digest === 'string') this.records.set(record.requestId, record);
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof CursorApiError) throw error;
        throw new CursorApiError('ledger_corrupt', 'Submission ledger is not valid JSON.');
      }
    }
    this.loaded = true;
  }

  async persist() {
    const records = [...this.records.values()].slice(-MAX_RECORDS);
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, records }), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.file);
    await chmod(this.file, 0o600).catch(() => {});
  }

  async lookup(requestId) {
    await this.init();
    return this.records.get(requestId) ?? null;
  }

  async begin({ requestId, kind, digest, agentId = null }) {
    await this.init();
    const existing = this.records.get(requestId);
    if (existing) {
      if (existing.digest !== digest || existing.kind !== kind) {
        throw new CursorApiError('request_id_conflict', 'The request ID was already used for a different operation.');
      }
      if (existing.status === 'uncertain') {
        throw new CursorApiError('uncertain_submission', 'A prior submission has an uncertain transport outcome; reconcile it before retrying.', { ambiguous: true });
      }
      if (existing.status === 'pending') {
        throw new CursorApiError('submission_in_progress', 'A submission with this request ID is already in progress.');
      }
      return { duplicate: true, record: existing };
    }
    const record = { requestId, kind, digest, status: 'pending', agentId, createdAt: now(), updatedAt: now() };
    this.records.set(requestId, record);
    await this.persist();
    return { duplicate: false, record };
  }

  async complete(requestId, fields = {}) {
    await this.init();
    const current = this.records.get(requestId);
    if (!current) return;
    const record = {
      ...current,
      ...fields,
      status: 'completed',
      updatedAt: now(),
    };
    this.records.set(requestId, record);
    await this.persist();
  }

  async uncertain(requestId, fields = {}) {
    await this.init();
    const current = this.records.get(requestId);
    if (!current) return;
    this.records.set(requestId, { ...current, ...fields, status: 'uncertain', updatedAt: now() });
    await this.persist();
  }
}
