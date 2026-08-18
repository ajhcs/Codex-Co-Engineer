import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';

export const ACP_EVENT_LEDGER_LIMITS = Object.freeze({
  events: 2_000,
  bytes: 8 * 1024 * 1024,
  record_bytes: 256,
  page_events: 200,
  page_bytes: 64 * 1024,
});

const EVENT_TYPES = new Set(['status', 'text', 'tool', 'usage', 'error', 'control']);
const EVENT_STATUSES = new Set([
  'creating', 'ready', 'running', 'completed', 'failed', 'cancelled', 'uncertain', 'closed',
]);
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const EXACT_EVENT_KEYS = new Set(['seq', 'type', 'status']);
const NOFOLLOW = constants.O_NOFOLLOW;
const APPEND = constants.O_APPEND;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const queues = new Map();
const LOCK_PAYLOAD_BYTES = 512;

export class AcpEventLedgerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'AcpEventLedgerError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new AcpEventLedgerError(code, message, cause ? { cause } : {});
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function identity(stat) {
  if (stat.dev === undefined || stat.ino === undefined) fail('identity_unsupported', 'Filesystem identity is unavailable.');
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(expected, stat) {
  return expected.dev === String(stat.dev) && expected.ino === String(stat.ino);
}

function currentUid() {
  if (typeof process.getuid !== 'function') fail('identity_unsupported', 'Owner verification is unavailable.');
  return process.getuid();
}

function assertDirectory(stat, { ownerOnly, label }) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_state', `${label} must be a real directory.`);
  if (ownerOnly && (stat.uid !== currentUid() || (stat.mode & 0o7777) !== DIRECTORY_MODE)) {
    fail('unsafe_state', `${label} must be owned by this user with exact mode 0700.`);
  }
  if (!ownerOnly) {
    const mode = stat.mode & 0o7777;
    if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
      fail('unsafe_state', `${label} is an unsafe writable ancestor.`);
    }
  }
}

function assertEventFile(stat) {
  if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe_event_file', 'ACP event storage must be a real regular file.');
  if (stat.uid !== currentUid() || (stat.mode & 0o7777) !== FILE_MODE || stat.nlink !== 1) {
    fail('unsafe_event_file', 'ACP event storage must be owner-only mode 0600 with exactly one link.');
  }
}

function assertLockFile(stat, { allowCandidateLink = false } = {}) {
  if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe_lock', 'ACP event writer lock must be a real regular file.');
  const linksOkay = stat.nlink === 1 || (allowCandidateLink && stat.nlink === 2);
  if (stat.uid !== currentUid() || (stat.mode & 0o7777) !== FILE_MODE || !linksOkay) {
    fail('unsafe_lock', 'ACP event writer lock has unsafe ownership, mode, or link count.');
  }
}

function procStartFromStat(text) {
  const close = text.lastIndexOf(') ');
  if (close < 1) fail('identity_unsupported', 'Linux process start identity is malformed.');
  const fields = text.slice(close + 2).trim().split(/\s+/u);
  const start = fields[19];
  if (!/^\d+$/u.test(start ?? '')) fail('identity_unsupported', 'Linux process start identity is unavailable.');
  return start;
}

async function linuxProcessStart(pid) {
  try {
    return procStartFromStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch (error) {
    if (error instanceof AcpEventLedgerError) throw error;
    if (error?.code === 'ENOENT') return null;
    // Permission denial or an unknown procfs failure is not evidence of death.
    fail('lock_owner_unknown', 'ACP event writer lock owner identity could not be proven.', error);
  }
}

async function checkedLstat(component, check) {
  let stat;
  try { stat = await lstat(component); } catch (error) {
    fail('state_unavailable', 'ACP event state could not be inspected.', error);
  }
  check(stat);
  return stat;
}

async function provisionRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root) {
    fail('invalid_state_root', 'state_root must be one canonical absolute path.');
  }
  const parsed = path.parse(root);
  const pieces = root.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let component = parsed.root;
  await checkedLstat(component, (stat) => assertDirectory(stat, { ownerOnly: false, label: 'Filesystem root' }));
  for (let index = 0; index < pieces.length; index += 1) {
    component = path.join(component, pieces[index]);
    const final = index === pieces.length - 1;
    try {
      const stat = await lstat(component);
      assertDirectory(stat, { ownerOnly: final, label: final ? 'State root' : 'State ancestor' });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try { await mkdir(component, { mode: DIRECTORY_MODE }); } catch (createError) {
        if (createError?.code !== 'EEXIST') fail('state_unavailable', 'ACP event state could not be provisioned.', createError);
      }
      const stat = await checkedLstat(component, (entry) => assertDirectory(entry, {
        ownerOnly: final,
        label: final ? 'State root' : 'State ancestor',
      }));
      // Newly-created ancestors are ours and must not become shared even when
      // they precede the configured root.
      if (stat.uid !== currentUid() || (stat.mode & 0o7777) !== DIRECTORY_MODE) {
        fail('unsafe_state', 'A newly-created state component is not owner-only.');
      }
    }
  }
}

async function provisionOwnerDirectory(component) {
  try { await mkdir(component, { mode: DIRECTORY_MODE }); } catch (error) {
    if (error?.code !== 'EEXIST') fail('state_unavailable', 'ACP event directory could not be provisioned.', error);
  }
  const stat = await checkedLstat(component, (entry) => assertDirectory(entry, { ownerOnly: true, label: 'ACP event directory' }));
  return Object.freeze({ component, ...identity(stat) });
}

function validateSessionId(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 128 || !SAFE_SESSION_ID.test(value)) {
    fail('invalid_session_id', 'session_id must be an opaque 8 to 128 byte managed identifier.');
  }
  return value;
}

function canonicalEvent(value, expectedSeq = null, { persisted = false } = {}) {
  if (!plainObject(value)) fail('invalid_event', 'event must be a plain object.');
  const keys = Object.keys(value);
  if (keys.some((key) => !EXACT_EVENT_KEYS.has(key))) fail('invalid_event', 'event contains unsupported metadata.');
  if (expectedSeq === null) {
    if (Object.hasOwn(value, 'seq')) fail('invalid_event', 'event.seq is assigned by the ledger.');
  } else if (persisted && value.seq !== expectedSeq) fail('event_sequence', 'ACP event sequence is not contiguous.');
  else if (!persisted && Object.hasOwn(value, 'seq')) fail('invalid_event', 'event.seq is assigned by the ledger.');
  if (!EVENT_TYPES.has(value.type)) fail('invalid_event', 'event.type is unsupported.');
  if (!EVENT_STATUSES.has(value.status)) fail('invalid_event', 'event.status is unsupported.');
  const event = { seq: expectedSeq ?? 0, type: value.type, status: value.status };
  if (Buffer.byteLength(`${JSON.stringify(event)}\n`, 'utf8') > ACP_EVENT_LEDGER_LIMITS.record_bytes) {
    fail('invalid_event', 'Canonical ACP event record exceeds its fixed ceiling.');
  }
  return event;
}

function strictDecode(buffer) {
  try { return UTF8.decode(buffer); } catch (error) { fail('event_tampered', 'ACP event storage is not strict UTF-8.', error); }
}

function parseLedger(buffer) {
  if (buffer.length > ACP_EVENT_LEDGER_LIMITS.bytes) fail('event_limit', 'ACP event storage exceeds its byte ceiling.');
  if (buffer.length > 0 && buffer.at(-1) !== 0x0a) fail('event_tampered', 'ACP event storage ends with a partial record.');
  const text = strictDecode(buffer);
  const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n');
  if (lines.length > ACP_EVENT_LEDGER_LIMITS.events) fail('event_limit', 'ACP event storage exceeds its event ceiling.');
  const events = lines.map((line, index) => {
    let parsed;
    try { parsed = JSON.parse(line); } catch (error) { fail('event_tampered', 'ACP event storage contains malformed JSON.', error); }
    const event = canonicalEvent(parsed, index + 1, { persisted: true });
    if (line !== JSON.stringify(event)) fail('event_tampered', 'ACP event storage contains a non-canonical record.');
    return Object.freeze(event);
  });
  return {
    buffer,
    events: Object.freeze(events),
    bytes: buffer.length,
    digest: createHash('sha256').update(buffer).digest('hex'),
  };
}

async function readWhole(file) {
  const stat = await file.stat();
  assertEventFile(stat);
  if (stat.size > ACP_EVENT_LEDGER_LIMITS.bytes) fail('event_limit', 'ACP event storage exceeds its byte ceiling.');
  const buffer = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) fail('event_tampered', 'ACP event storage was truncated while being read.');
    offset += bytesRead;
  }
  return parseLedger(buffer);
}

function metadata(sessionId, snapshot) {
  return Object.freeze({
    session_id: sessionId,
    event_count: snapshot.events.length,
    event_bytes: snapshot.bytes,
    last_seq: snapshot.events.length,
    digest: snapshot.digest,
  });
}

function verifyExpected(snapshot, expected) {
  if (expected === undefined || expected === null) return;
  if (!plainObject(expected)
    || Object.keys(expected).some((key) => !['event_count', 'event_bytes', 'last_seq', 'digest'].includes(key))
    || expected.event_count !== snapshot.events.length
    || expected.event_bytes !== snapshot.bytes
    || expected.last_seq !== snapshot.events.length
    || expected.digest !== snapshot.digest) {
    fail('counter_mismatch', 'ACP event counters or digest do not match durable storage.');
  }
}

function enqueue(key, operation) {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(key, current);
  return current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  });
}

export async function openAcpEventLedger({ state_root: stateRoot, session_id: sessionId }) {
  if (!Number.isInteger(NOFOLLOW) || NOFOLLOW === 0 || !Number.isInteger(APPEND) || APPEND === 0) {
    fail('identity_unsupported', 'Secure ACP event storage requires O_NOFOLLOW and O_APPEND.');
  }
  validateSessionId(sessionId);
  await provisionRoot(stateRoot);
  const eventRootPath = path.join(stateRoot, 'acp-events');
  const eventRoot = await provisionOwnerDirectory(eventRootPath);
  const sessionPath = path.join(eventRootPath, sessionId);
  const sessionDirectory = await provisionOwnerDirectory(sessionPath);
  const filePath = path.join(sessionPath, 'events.ndjson');
  const lockPath = path.join(sessionPath, 'append.lock');

  let file;
  try {
    file = await open(filePath, constants.O_RDWR | APPEND | constants.O_CREAT | NOFOLLOW, FILE_MODE);
  } catch (error) {
    fail(error?.code === 'ELOOP' ? 'unsafe_event_file' : 'state_unavailable', 'ACP event storage could not be opened.', error);
  }
  let fileIdentity;
  let snapshot;
  try {
    const stat = await file.stat();
    assertEventFile(stat);
    fileIdentity = Object.freeze({ component: filePath, ...identity(stat) });
    snapshot = await readWhole(file);
  } catch (error) {
    await file.close().catch(() => {});
    throw error;
  }

  const rootStat = await checkedLstat(stateRoot, (entry) => assertDirectory(entry, { ownerOnly: true, label: 'State root' }));
  const retained = Object.freeze([
    Object.freeze({ component: stateRoot, kind: 'directory', ...identity(rootStat) }),
    Object.freeze({ ...eventRoot, kind: 'directory' }),
    Object.freeze({ ...sessionDirectory, kind: 'directory' }),
    Object.freeze({ ...fileIdentity, kind: 'file' }),
  ]);
  const queueKey = `${fileIdentity.dev}:${fileIdentity.ino}`;
  let closed = false;

  async function revalidate() {
    for (const expected of retained) {
      const stat = await checkedLstat(expected.component, (entry) => {
        if (expected.kind === 'file') assertEventFile(entry);
        else assertDirectory(entry, { ownerOnly: true, label: 'ACP event directory' });
      });
      if (!sameIdentity(expected, stat)) fail('identity_changed', 'ACP event state changed during use.');
    }
    const fdStat = await file.stat();
    assertEventFile(fdStat);
    if (!sameIdentity(fileIdentity, fdStat)) fail('identity_changed', 'ACP event file changed during use.');
    return fdStat;
  }

  async function revalidateDirectories() {
    for (const expected of retained.slice(0, 3)) {
      const stat = await checkedLstat(expected.component, (entry) => {
        assertDirectory(entry, { ownerOnly: true, label: 'ACP event directory' });
      });
      if (!sameIdentity(expected, stat)) fail('identity_changed', 'ACP event state changed during use.');
    }
  }

  async function acquireFileLock() {
    const ownerStart = await linuxProcessStart(process.pid);
    if (ownerStart === null) fail('identity_unsupported', 'Current process identity disappeared from procfs.');

    async function recoverDeadLock(listed) {
      assertLockFile(listed, { allowCandidateLink: true });
      const lockIdentity = identity(listed);
      let existing;
      try {
        existing = await open(lockPath, constants.O_RDONLY | NOFOLLOW);
        const opened = await existing.stat();
        assertLockFile(opened, { allowCandidateLink: true });
        if (!sameIdentity(lockIdentity, opened) || opened.size < 2 || opened.size > LOCK_PAYLOAD_BYTES) {
          fail('unsafe_lock', 'ACP event writer lock identity or payload size is invalid.');
        }
        const bytes = Buffer.alloc(opened.size);
        const result = await existing.read(bytes, 0, bytes.length, 0);
        if (result.bytesRead !== bytes.length) fail('unsafe_lock', 'ACP event writer lock payload is incomplete.');
        const text = strictDecode(bytes);
        if (!text.endsWith('\n')) fail('unsafe_lock', 'ACP event writer lock payload is incomplete.');
        let payload;
        try { payload = JSON.parse(text.slice(0, -1)); } catch (error) {
          fail('unsafe_lock', 'ACP event writer lock payload is malformed.', error);
        }
        const keys = ['pid', 'start', 'nonce', 'dev', 'ino'];
        if (!plainObject(payload) || Object.keys(payload).length !== keys.length
          || keys.some((key, index) => Object.keys(payload)[index] !== key)
          || !Number.isSafeInteger(payload.pid) || payload.pid < 1
          || !/^\d+$/u.test(payload.start)
          || !/^[a-f0-9]{64}$/u.test(payload.nonce)
          || payload.dev !== lockIdentity.dev || payload.ino !== lockIdentity.ino
          || text !== `${JSON.stringify(payload)}\n`) {
          fail('unsafe_lock', 'ACP event writer lock payload is not canonical or identity-bound.');
        }
        const liveStart = await linuxProcessStart(payload.pid);
        if (liveStart === payload.start) return false;

        const candidatePath = path.join(sessionPath, `.append.lock.${payload.pid}.${payload.start}.${payload.nonce}`);
        let candidate = null;
        if (opened.nlink === 2) {
          candidate = await checkedLstat(candidatePath, (entry) => assertLockFile(entry, { allowCandidateLink: true }));
          if (!sameIdentity(lockIdentity, candidate)) fail('unsafe_lock', 'ACP event writer lock candidate identity is invalid.');
        }
        await revalidateDirectories();
        const confirmed = await checkedLstat(lockPath, (entry) => assertLockFile(entry, { allowCandidateLink: true }));
        const confirmedFd = await existing.stat();
        if (!sameIdentity(lockIdentity, confirmed) || !sameIdentity(lockIdentity, confirmedFd)) {
          fail('identity_changed', 'ACP event writer lock changed during stale recovery.');
        }
        await unlink(lockPath);
        if (candidate) {
          const remaining = await checkedLstat(candidatePath, assertEventFile);
          if (!sameIdentity(lockIdentity, remaining)) fail('identity_changed', 'ACP event lock candidate changed during recovery.');
          await unlink(candidatePath);
        }
        await revalidateDirectories();
        return true;
      } finally {
        await existing?.close().catch(() => {});
      }
    }

    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      await revalidateDirectories();
      let listed;
      try {
        listed = await lstat(lockPath);
      } catch (inspectError) {
        if (inspectError?.code !== 'ENOENT') fail('state_unavailable', 'ACP event writer lock could not be inspected.', inspectError);
      }
      if (listed) {
        const recovered = await recoverDeadLock(listed);
        if (recovered) continue;
        await delay(5);
        continue;
      }

      const nonce = randomBytes(32).toString('hex');
      const candidatePath = path.join(sessionPath, `.append.lock.${process.pid}.${ownerStart}.${nonce}`);
      let lock;
      let acquiredIdentity = null;
      try {
        lock = await open(
          candidatePath,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
          FILE_MODE,
        );
        const stat = await lock.stat();
        assertEventFile(stat);
        const lockIdentity = identity(stat);
        acquiredIdentity = lockIdentity;
        const payload = Buffer.from(`${JSON.stringify({
          pid: process.pid,
          start: ownerStart,
          nonce,
          dev: lockIdentity.dev,
          ino: lockIdentity.ino,
        })}\n`, 'utf8');
        if (payload.length > LOCK_PAYLOAD_BYTES) fail('unsafe_lock', 'ACP event writer lock payload exceeds its ceiling.');
        const written = await lock.write(payload, 0, payload.length, 0);
        if (written.bytesWritten !== payload.length) fail('lock_uncertain', 'ACP event writer lock payload write was partial.');
        await lock.sync();
        await revalidateDirectories();
        const candidate = await checkedLstat(candidatePath, assertEventFile);
        if (!sameIdentity(lockIdentity, candidate)) fail('identity_changed', 'ACP event writer lock candidate changed during acquisition.');
        try { await link(candidatePath, lockPath); } catch (error) {
          if (error?.code !== 'EEXIST') fail('state_unavailable', 'ACP event writer lock could not be linked atomically.', error);
          await lock.close();
          lock = null;
          const remaining = await checkedLstat(candidatePath, assertEventFile);
          if (!sameIdentity(lockIdentity, remaining)) fail('identity_changed', 'ACP event writer lock candidate changed after contention.');
          await unlink(candidatePath);
          continue;
        }
        const linked = await checkedLstat(lockPath, (entry) => assertLockFile(entry, { allowCandidateLink: true }));
        if (!sameIdentity(lockIdentity, linked) || linked.nlink !== 2) fail('identity_changed', 'ACP event writer lock link is invalid.');
        await unlink(candidatePath);
        const active = await checkedLstat(lockPath, assertEventFile);
        if (!sameIdentity(lockIdentity, active)) fail('identity_changed', 'ACP event writer lock changed during activation.');
        return async () => {
          try {
            await revalidateDirectories();
            const before = await checkedLstat(lockPath, assertEventFile);
            const opened = await lock.stat();
            assertEventFile(opened);
            if (!sameIdentity(lockIdentity, before) || !sameIdentity(lockIdentity, opened)) {
              fail('identity_changed', 'ACP event writer lock changed before release.');
            }
            await lock.close();
            lock = null;
            const confirmed = await checkedLstat(lockPath, assertEventFile);
            if (!sameIdentity(lockIdentity, confirmed)) fail('identity_changed', 'ACP event writer lock changed before unlink.');
            await unlink(lockPath);
            await revalidateDirectories();
          } finally {
            await lock?.close().catch(() => {});
          }
        };
      } catch (error) {
        await lock?.close().catch(() => {});
        for (const cleanupPath of [lockPath, candidatePath]) {
          const cleanup = await lstat(cleanupPath).catch(() => null);
          if (acquiredIdentity && cleanup?.isFile() && sameIdentity(acquiredIdentity, cleanup)
            && cleanup.uid === currentUid() && cleanup.nlink <= 2
            && (cleanup.mode & 0o7777) === FILE_MODE) await unlink(cleanupPath).catch(() => {});
        }
        throw error;
      }
    }
    fail('lock_timeout', 'ACP event writer lock remained busy.');
  }

  async function serialize(operation, { beforeLock = null } = {}) {
    return enqueue(queueKey, async () => {
      beforeLock?.();
      const release = await acquireFileLock();
      try { return await operation(); } finally { await release(); }
    });
  }

  async function refresh({ requireContent = false } = {}) {
    const before = await revalidate();
    if (before.size < snapshot.bytes) {
      fail('event_tampered', 'ACP event storage was externally truncated.');
    }
    if (before.size > snapshot.bytes) {
      const advanced = await readWhole(file);
      if (!advanced.buffer.subarray(0, snapshot.bytes).equals(snapshot.buffer)) {
        fail('event_tampered', 'ACP event storage does not extend its verified prefix.');
      }
      snapshot = advanced;
    }
    if (requireContent) {
      const verified = await readWhole(file);
      if (verified.digest !== snapshot.digest || verified.bytes !== snapshot.bytes
        || verified.events.length !== snapshot.events.length) {
        fail('event_tampered', 'ACP event storage content no longer matches its verified digest.');
      }
    } else {
      // Same-size mutations are detected by timestamps; content is then read
      // and digested to distinguish a harmless metadata change from tamper.
      const known = snapshot.stat;
      if (known && (before.mtimeMs !== known.mtimeMs || before.ctimeMs !== known.ctimeMs)) {
        const verified = await readWhole(file);
        if (verified.digest !== snapshot.digest) {
          fail('event_tampered', 'ACP event storage content no longer matches its verified digest.');
        }
      }
    }
    const after = await revalidate();
    if (after.size !== snapshot.bytes) fail('event_tampered', 'ACP event storage changed during verification.');
    snapshot.stat = Object.freeze({ mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs });
    return snapshot;
  }
  await refresh({ requireContent: true });

  const api = {
    async inspect({ expected } = {}) {
      return serialize(async () => {
        if (closed) fail('ledger_closed', 'ACP event ledger is closed.');
        await refresh({ requireContent: true });
        verifyExpected(snapshot, expected);
        return metadata(sessionId, snapshot);
      });
    },

    async append(input, { expected } = {}) {
      return serialize(async () => {
        if (closed) fail('ledger_closed', 'ACP event ledger is closed.');
        await refresh();
        verifyExpected(snapshot, expected);
        if (snapshot.events.length >= ACP_EVENT_LEDGER_LIMITS.events) fail('event_limit', 'ACP event count ceiling reached.');
        const event = canonicalEvent(input, snapshot.events.length + 1);
        const record = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
        if (snapshot.bytes + record.length > ACP_EVENT_LEDGER_LIMITS.bytes) fail('event_limit', 'ACP event byte ceiling reached.');
        const before = await revalidate();
        if (before.size !== snapshot.bytes) fail('event_tampered', 'ACP event storage changed before append.');
        const { bytesWritten } = await file.write(record, 0, record.length, null);
        if (bytesWritten !== record.length) fail('append_uncertain', 'ACP event append was partial; manual reconciliation is required.');
        await file.sync();
        const after = await revalidate();
        if (after.size !== snapshot.bytes + record.length) fail('append_uncertain', 'ACP event append outcome is uncertain.');
        const buffer = Buffer.concat([snapshot.buffer, record]);
        snapshot = parseLedger(buffer);
        snapshot.stat = Object.freeze({ mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs });
        await revalidate();
        return Object.freeze({ event: Object.freeze(event), ...metadata(sessionId, snapshot) });
      }, { beforeLock: () => {
        if (snapshot.events.length >= ACP_EVENT_LEDGER_LIMITS.events) {
          fail('event_limit', 'ACP event count ceiling reached.');
        }
      } });
    },

    async page({ after_seq: afterSeq = 0, max_events: maxEvents = 200, max_bytes: maxBytes = 64 * 1024, expected } = {}) {
      return serialize(async () => {
        if (closed) fail('ledger_closed', 'ACP event ledger is closed.');
        if (!Number.isSafeInteger(afterSeq) || afterSeq < 0
          || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > ACP_EVENT_LEDGER_LIMITS.page_events
          || !Number.isSafeInteger(maxBytes) || maxBytes < ACP_EVENT_LEDGER_LIMITS.record_bytes
          || maxBytes > ACP_EVENT_LEDGER_LIMITS.page_bytes) {
          fail('invalid_page', 'ACP event page bounds are invalid.');
        }
        await refresh({ requireContent: true });
        verifyExpected(snapshot, expected);
        if (afterSeq > snapshot.events.length) fail('invalid_cursor', 'after_seq is beyond the durable event cursor.');
        const events = [];
        let used = 0;
        for (let index = afterSeq; index < snapshot.events.length && events.length < maxEvents; index += 1) {
          const event = snapshot.events[index];
          const bytes = Buffer.byteLength(`${JSON.stringify(event)}\n`, 'utf8');
          if (used + bytes > maxBytes) break;
          events.push(event);
          used += bytes;
        }
        const nextSeq = events.length > 0 ? events.at(-1).seq : afterSeq;
        return Object.freeze({
          session_id: sessionId,
          events: Object.freeze([...events]),
          next_seq: nextSeq,
          has_more: nextSeq < snapshot.events.length,
          page_bytes: used,
          event_count: snapshot.events.length,
          event_bytes: snapshot.bytes,
          digest: snapshot.digest,
        });
      });
    },

    async cleanup({ expected } = {}) {
      return serialize(async () => {
        if (closed) fail('ledger_closed', 'ACP event ledger is closed.');
        if (!plainObject(expected) || Object.keys(expected).length !== 4) {
          fail('cleanup_forbidden', 'Cleanup requires exact durable counters and digest.');
        }
        await refresh({ requireContent: true });
        verifyExpected(snapshot, expected);
        const finalEvent = snapshot.events.at(-1);
        const terminal = new Set(['completed', 'failed', 'cancelled', 'closed']);
        if (!finalEvent || !terminal.has(finalEvent.status)
          || snapshot.events.some((event) => event.status === 'uncertain')) {
          fail('cleanup_forbidden', 'Cleanup requires a verified terminal, never-uncertain durable event history.');
        }
        await revalidate();
        await file.close();
        closed = true;
        const listed = await checkedLstat(filePath, assertEventFile);
        if (!sameIdentity(fileIdentity, listed)) fail('identity_changed', 'ACP event file changed before cleanup.');
        await unlink(filePath);
        await checkedLstat(eventRootPath, (entry) => assertDirectory(entry, { ownerOnly: true, label: 'ACP event directory' }));
        return Object.freeze({ session_id: sessionId, cleaned: true });
      });
    },

    async close() {
      return enqueue(queueKey, async () => {
        if (!closed) {
          // Closing an fd is always safe even if an owner has already removed
          // the state tree during shutdown. Durable mutations use the lock.
          await file.close();
          closed = true;
        }
      });
    },
  };
  return Object.freeze(api);
}
