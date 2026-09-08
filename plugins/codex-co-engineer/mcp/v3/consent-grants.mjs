import { execFile as nodeExecFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod, lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export const CONSENT_GRANT_SCHEMA = 'codex-co-engineer.consent-grants.v1';
export const CONSENT_GRANT_VERSION = 1;
export const CONSENT_GRANT_DURATION = 'repository_and_selected_providers';
export const CONSENT_RUN_DURATION = 'this_run_only';
export const CONSENT_GRANT_STORE_FILE = 'consent-grants.json';

const execFile = promisify(nodeExecFile);
const PROVIDERS = new Set(['grok', 'cursor-local', 'cursor-cloud', 'dsh']);
const MAX_STORE_BYTES = 64 * 1024;
const LOCK_WAIT_ATTEMPTS = 200;
const SHA256 = /^[0-9a-f]{64}$/u;
const CLOSED_GIT_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  LANG: 'C',
  LC_ALL: 'C',
});

function grantError(code, message) {
  return Object.assign(new Error(message), { code });
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalProviders(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 4) {
    throw grantError('consent_grant_invalid', 'Consent grant providers are invalid.');
  }
  const providers = [];
  for (const value of values) {
    if (typeof value !== 'string' || !PROVIDERS.has(value) || providers.includes(value)) {
      throw grantError('consent_grant_invalid', 'Consent grant providers are invalid.');
    }
    providers.push(value);
  }
  return providers.sort();
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) return null;
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(value);
  if (scp && !value.includes('://')) {
    const pathname = scp[2].replace(/^\/+|\/+$/gu, '');
    return /^[A-Za-z0-9.-]+$/u.test(scp[1]) && pathname.length > 0
      ? `ssh://${scp[1].toLowerCase()}/${pathname}`
      : `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
  }
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) {
      return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'https:' && parsed.port === '443')
      || (parsed.protocol === 'http:' && parsed.port === '80')
      || (parsed.protocol === 'ssh:' && parsed.port === '22')) parsed.port = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/gu, '');
    return parsed.hostname && parsed.pathname
      ? parsed.toString()
      : `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
  } catch {
    return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
  }
}

async function git(repositoryPath, args, { optional = false } = {}) {
  try {
    const result = await execFile('git', ['-C', repositoryPath, ...args], {
      env: CLOSED_GIT_ENV,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch (error) {
    if (optional && error?.code === 1 && error?.killed !== true) return null;
    throw grantError('consent_repository_identity_failed',
      'The repository identity could not be resolved for consent.');
  }
}

export async function resolveConsentRepositoryIdentity(repositoryPath) {
  if (typeof repositoryPath !== 'string' || !path.isAbsolute(repositoryPath)) {
    throw grantError('consent_repository_identity_failed',
      'Consent requires an absolute repository path.');
  }
  const commonDirValue = await git(repositoryPath,
    ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDirPath = await realpath(commonDirValue).catch(() => null);
  if (commonDirPath === null || !path.isAbsolute(commonDirPath)) {
    throw grantError('consent_repository_identity_failed',
      'The repository common directory could not be resolved for consent.');
  }
  const metadata = await stat(commonDirPath, { bigint: true }).catch(() => null);
  if (metadata === null || !metadata.isDirectory()) {
    throw grantError('consent_repository_identity_failed',
      'The repository common directory is unavailable for consent.');
  }
  const rawOrigin = await git(repositoryPath, ['config', '--local', '--get', 'remote.origin.url'], {
    optional: true,
  });
  return Object.freeze({
    common_dir_path: commonDirPath,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    birthtime_ns: String(metadata.birthtimeNs),
    origin: normalizeOrigin(rawOrigin),
  });
}

function identityKey(identity) {
  return JSON.stringify([
    identity.common_dir_path, identity.device, identity.inode, identity.birthtime_ns, identity.origin,
  ]);
}

function grantId(identity) {
  return createHash('sha256').update(identityKey(identity), 'utf8').digest('hex');
}

function validateIdentity(value) {
  if (!exactKeys(value, ['common_dir_path', 'device', 'inode', 'birthtime_ns', 'origin'])
    || typeof value.common_dir_path !== 'string' || !path.isAbsolute(value.common_dir_path)
    || typeof value.device !== 'string' || !/^\d+$/u.test(value.device)
    || typeof value.inode !== 'string' || !/^\d+$/u.test(value.inode)
    || typeof value.birthtime_ns !== 'string' || !/^\d+$/u.test(value.birthtime_ns)
    || (value.origin !== null && (typeof value.origin !== 'string'
      || (!/^sha256:[0-9a-f]{64}$/u.test(value.origin)
        && normalizeOrigin(value.origin) !== value.origin)))) {
    throw grantError('consent_grant_store_invalid', 'Consent grant state is malformed.');
  }
  return value;
}

function validateStore(value) {
  if (!exactKeys(value, ['schema', 'version', 'grants'])
    || value.schema !== CONSENT_GRANT_SCHEMA || value.version !== CONSENT_GRANT_VERSION
    || !Array.isArray(value.grants) || value.grants.length > 256) {
    throw grantError('consent_grant_store_invalid', 'Consent grant state is malformed.');
  }
  const ids = new Set();
  for (const grant of value.grants) {
    if (!exactKeys(grant, ['grant_id', 'repository', 'providers', 'granted_at'])
      || typeof grant.grant_id !== 'string' || !SHA256.test(grant.grant_id)
      || typeof grant.granted_at !== 'string' || !Number.isFinite(Date.parse(grant.granted_at))) {
      throw grantError('consent_grant_store_invalid', 'Consent grant state is malformed.');
    }
    validateIdentity(grant.repository);
    if (grant.grant_id !== grantId(grant.repository) || ids.has(grant.grant_id)) {
      throw grantError('consent_grant_store_invalid', 'Consent grant state is malformed.');
    }
    ids.add(grant.grant_id);
    try { canonicalProviders(grant.providers); } catch {
      throw grantError('consent_grant_store_invalid', 'Consent grant state is malformed.');
    }
    if (JSON.stringify(grant.providers) !== JSON.stringify(canonicalProviders(grant.providers))) {
      throw grantError('consent_grant_store_invalid', 'Consent grant state is malformed.');
    }
  }
  return value;
}

function emptyStore() {
  return { schema: CONSENT_GRANT_SCHEMA, version: CONSENT_GRANT_VERSION, grants: [] };
}

async function assertPrivate(metadata, kind) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (metadata.isSymbolicLink() || (uid !== null && metadata.uid !== uid)
    || (metadata.mode & 0o077) !== 0) {
    throw grantError('consent_grant_store_unsafe', `Consent grant ${kind} is not owner-only.`);
  }
}

export function createConsentGrantStore({ root }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('createConsentGrantStore requires an absolute state root.');
  }
  const directory = path.resolve(root);
  const file = path.join(directory, CONSENT_GRANT_STORE_FILE);
  const lockFile = path.join(directory, '.consent-grants.lock');

  async function prepareDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertPrivate(await lstat(directory), 'directory');
  }

  async function acquireLock() {
    const nonce = randomUUID();
    for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt += 1) {
      try {
        const handle = await open(lockFile, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce })}\n`);
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => {});
          await unlink(lockFile).catch(() => {});
          throw error;
        }
        return { handle, nonce };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (attempt === LOCK_WAIT_ATTEMPTS - 1) {
          throw grantError('consent_grant_store_busy',
            'Consent grant state is busy. If no consent command or MCP server is running, remove the owner-only .consent-grants.lock file from the Co-Engineer state directory.');
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw grantError('consent_grant_store_busy', 'Consent grant state is busy.');
  }

  async function withMutationLock(operation) {
    await prepareDirectory();
    const lock = await acquireLock();
    try {
      return await operation();
    } finally {
      await lock.handle.close().catch(() => {});
      try {
        const current = JSON.parse(await readFile(lockFile, 'utf8'));
        if (current.nonce === lock.nonce) await unlink(lockFile);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }

  async function load() {
    await prepareDirectory();
    let metadata;
    try { metadata = await lstat(file); } catch (error) {
      if (error?.code === 'ENOENT') return emptyStore();
      throw grantError('consent_grant_store_invalid', 'Consent grant state could not be read.');
    }
    await assertPrivate(metadata, 'file');
    if (!metadata.isFile() || metadata.size > MAX_STORE_BYTES) {
      throw grantError('consent_grant_store_invalid', 'Consent grant state is malformed.');
    }
    let parsed;
    try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch {
      throw grantError('consent_grant_store_invalid', 'Consent grant state is malformed.');
    }
    return validateStore(parsed);
  }

  async function save(store) {
    validateStore(store);
    await prepareDirectory();
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    const bytes = `${JSON.stringify(store, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_STORE_BYTES) {
      throw grantError('consent_grant_store_invalid', 'Consent grant state exceeds its size limit.');
    }
    try {
      await writeFile(temporary, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      const handle = await open(temporary, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
      const directoryHandle = await open(directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async function lookup({ repositoryPath, repositoryIdentity, providers }) {
    const requested = canonicalProviders(providers);
    const repository = repositoryIdentity === undefined
      ? await resolveConsentRepositoryIdentity(repositoryPath)
      : validateIdentity(repositoryIdentity);
    const store = await load();
    const grant = store.grants.find((item) => item.grant_id === grantId(repository));
    if (!grant || identityKey(grant.repository) !== identityKey(repository)
      || !requested.every((provider) => grant.providers.includes(provider))) return null;
    return Object.freeze({
      approved: true,
      duration: CONSENT_GRANT_DURATION,
      source: 'durable_grant',
      grant_id: grant.grant_id,
    });
  }

  async function assertIdentityCurrent({ repositoryPath, repositoryIdentity }) {
    const expected = validateIdentity(repositoryIdentity);
    const current = await resolveConsentRepositoryIdentity(repositoryPath);
    if (identityKey(expected) !== identityKey(current)) {
      throw grantError('consent_repository_identity_changed',
        'The repository identity changed while consent was open. Request consent again.');
    }
    return true;
  }

  async function remember({
    repositoryPath, repositoryIdentity, providers, grantedAt = new Date().toISOString(),
  }) {
    const requested = canonicalProviders(providers);
    if (typeof grantedAt !== 'string' || !Number.isFinite(Date.parse(grantedAt))) {
      throw grantError('consent_grant_invalid', 'Consent grant time is invalid.');
    }
    const repository = await resolveConsentRepositoryIdentity(repositoryPath);
    if (repositoryIdentity !== undefined
      && identityKey(validateIdentity(repositoryIdentity)) !== identityKey(repository)) {
      throw grantError('consent_repository_identity_changed',
        'The repository identity changed while consent was open.');
    }
    return withMutationLock(async () => {
      const store = await load();
      const id = grantId(repository);
      const existing = store.grants.find((item) => item.grant_id === id);
      const combined = canonicalProviders([...(existing?.providers ?? []), ...requested]
        .filter((provider, index, values) => values.indexOf(provider) === index));
      const grant = { grant_id: id, repository, providers: combined, granted_at: grantedAt };
      store.grants = [...store.grants.filter((item) => item.grant_id !== id), grant]
        .sort((left, right) => left.grant_id.localeCompare(right.grant_id));
      await save(store);
      return Object.freeze({ ...grant, duration: CONSENT_GRANT_DURATION });
    });
  }

  async function list() {
    const store = await load();
    return Object.freeze(store.grants.map((grant) => Object.freeze({
      grant_id: grant.grant_id,
      repository: grant.repository.common_dir_path,
      origin: grant.repository.origin,
      providers: Object.freeze([...grant.providers]),
      granted_at: grant.granted_at,
    })));
  }

  async function revoke({ repositoryPath, grantId: requestedGrantId }) {
    if ((repositoryPath === undefined) === (requestedGrantId === undefined)) {
      throw grantError('consent_grant_invalid', 'Revoke requires exactly one repository path or grant id.');
    }
    const repository = requestedGrantId === undefined
      ? await resolveConsentRepositoryIdentity(repositoryPath)
      : null;
    if (requestedGrantId !== undefined
      && (typeof requestedGrantId !== 'string' || !SHA256.test(requestedGrantId))) {
      throw grantError('consent_grant_invalid', 'Consent grant id is invalid.');
    }
    return withMutationLock(async () => {
      const store = await load();
      const grants = store.grants.filter((item) => requestedGrantId !== undefined
        ? item.grant_id !== requestedGrantId
        : !(item.repository.common_dir_path === repository.common_dir_path
          && item.repository.device === repository.device
          && item.repository.inode === repository.inode
          && item.repository.birthtime_ns === repository.birthtime_ns));
      if (grants.length === store.grants.length) return false;
      store.grants = grants;
      await save(store);
      return true;
    });
  }

  return Object.freeze({
    lookup,
    remember,
    list,
    revoke,
    resolveIdentity: resolveConsentRepositoryIdentity,
    assertIdentityCurrent,
  });
}
