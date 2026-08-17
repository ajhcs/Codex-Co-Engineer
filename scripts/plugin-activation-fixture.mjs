#!/usr/bin/env node

/**
 * Deterministic fixture for the Codex app's staged-plugin lifecycle.
 *
 * This is intentionally a repository-owned model, not an implementation of
 * the Codex plugin manager. It uses a temporary directory under the system
 * temp root and never reads or writes ~/.codex/cache, the real skill catalog,
 * or a provider. Real catalog refreshes, task leases, and fresh-task schema
 * acceptance remain Codex app-owned integration work.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PLUGIN = 'fixture-plugin';
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const METADATA_FILE = '.codex-version.json';
const NEXT_MARKER = '.next-';

function assertToken(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.match(value, VERSION_PATTERN, `${label} contains an unsafe path token`);
  return value;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function atomicWrite(file, value) {
  const temporary = `${file}${NEXT_MARKER}${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, json(value), { mode: 0o600 });
  await rename(temporary, file);
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function digestFiles(files) {
  const hash = createHash('sha256');
  for (const [name, contents] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(name);
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function validateRelativeFile(name) {
  assert.equal(typeof name, 'string', 'fixture file names must be strings');
  assert.ok(name.length > 0 && !path.posix.isAbsolute(name), `unsafe fixture file ${name}`);
  const normalized = path.posix.normalize(name);
  assert.equal(normalized, name, `fixture file must be normalized: ${name}`);
  assert.ok(normalized !== '..' && !normalized.startsWith('../'), `fixture file escapes version: ${name}`);
  return name;
}

async function collectFiles(directory, relative = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === METADATA_FILE) continue;
    const entryRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await collectFiles(absolute, entryRelative));
      continue;
    }
    assert.ok(entry.isFile(), `sealed version contains unsupported entry ${entryRelative}`);
    files[entryRelative] = await readFile(absolute, 'utf8');
  }
  return files;
}

class ActivationFixture {
  constructor(root) {
    this.root = root;
    this.cacheRoot = path.join(root, 'plugins', 'cache');
    this.activeRoot = path.join(root, 'plugins', 'active');
    this.leaseRoot = path.join(root, 'tasks', 'leases');
    this.transactionRoot = path.join(root, 'plugins', 'transactions');
  }

  cacheDirectory(plugin) {
    return path.join(this.cacheRoot, assertToken(plugin, 'plugin'));
  }

  versionDirectory(plugin, version) {
    return path.join(this.cacheDirectory(plugin), assertToken(version, 'version'));
  }

  activePointer(plugin) {
    return path.join(this.activeRoot, assertToken(plugin, 'plugin'));
  }

  transactionFile(plugin) {
    return path.join(this.transactionRoot, `${assertToken(plugin, 'plugin')}.json`);
  }

  leaseFile(taskId) {
    assert.equal(typeof taskId, 'string', 'taskId must be a string');
    assert.ok(taskId.length > 0 && taskId.length <= 160, 'taskId must be bounded and non-empty');
    const encoded = encodeURIComponent(taskId);
    return path.join(this.leaseRoot, `${encoded}.json`);
  }

  async init() {
    await Promise.all([
      mkdir(this.cacheRoot, { recursive: true, mode: 0o755 }),
      mkdir(this.activeRoot, { recursive: true, mode: 0o755 }),
      mkdir(this.leaseRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.transactionRoot, { recursive: true, mode: 0o700 }),
    ]);
  }

  async stage(plugin, version, files) {
    assertToken(plugin, 'plugin');
    assertToken(version, 'version');
    assert.ok(files && typeof files === 'object' && !Array.isArray(files), 'fixture files must be an object');
    const entries = Object.entries(files);
    assert.ok(entries.length > 0, 'fixture versions must contain at least one file');
    for (const [name, contents] of entries) {
      validateRelativeFile(name);
      assert.equal(typeof contents, 'string', `fixture contents for ${name} must be text`);
    }

    const cache = this.cacheDirectory(plugin);
    const destination = this.versionDirectory(plugin, version);
    assert.equal(await exists(destination), false, `version ${version} is already staged and immutable`);
    await mkdir(cache, { recursive: true, mode: 0o755 });
    const temporary = path.join(cache, `.staging-${version}-${process.pid}-${Math.random().toString(16).slice(2)}`);
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    const digest = digestFiles(files);
    try {
      for (const [name, contents] of entries) {
        const file = path.join(temporary, name);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      }
      await writeFile(path.join(temporary, METADATA_FILE), json({
        schemaVersion: 1,
        plugin,
        version,
        digest,
        immutable: true,
      }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await this.seal(temporary);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
    return { plugin, version, digest, path: destination };
  }

  async seal(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.seal(file);
        // Keep directory traversal/write permission so the fixture can clean
        // its own temporary tree. File contents and the sealed manifest are
        // read-only; the digest is the immutable-version authority.
        await chmod(file, 0o755);
      } else {
        await chmod(file, 0o444);
      }
    }
    await chmod(directory, 0o755);
  }

  async verify(plugin, version) {
    const directory = this.versionDirectory(plugin, version);
    const metadata = await readJson(path.join(directory, METADATA_FILE));
    assert.deepEqual(metadata, {
      schemaVersion: 1,
      plugin,
      version,
      digest: metadata.digest,
      immutable: true,
    }, `sealed metadata mismatch for ${plugin}@${version}`);
    const files = await collectFiles(directory);
    const digest = digestFiles(files);
    assert.equal(digest, metadata.digest, `sealed version digest changed for ${plugin}@${version}`);
    return { directory, metadata, files };
  }

  async activeVersion(plugin) {
    const pointer = this.activePointer(plugin);
    if (!(await exists(pointer))) return null;
    const pointerStat = await lstat(pointer);
    assert.ok(pointerStat.isSymbolicLink(), `active pointer for ${plugin} must be a symlink`);
    const target = await readlink(pointer);
    const resolved = path.resolve(path.dirname(pointer), target);
    const cache = this.cacheDirectory(plugin);
    const relative = path.relative(cache, resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `active pointer for ${plugin} escapes cache`);
    assert.equal(relative.split(path.sep).length, 1, `active pointer for ${plugin} must target one version`);
    const version = relative;
    await this.verify(plugin, version);
    assert.equal(await realpath(pointer), await realpath(this.versionDirectory(plugin, version)));
    return version;
  }

  async activate(plugin, version, { crashAfterPointerPrepared = false, crashAfterPointerSwap = false } = {}) {
    await this.verify(plugin, version);
    const pointer = this.activePointer(plugin);
    const fromVersion = await this.activeVersion(plugin);
    const transaction = this.transactionFile(plugin);
    const temporaryName = `${assertToken(plugin, 'plugin')}${NEXT_MARKER}${process.pid}-${Math.random().toString(16).slice(2)}`;
    const temporary = path.join(this.activeRoot, temporaryName);
    const target = path.relative(this.activeRoot, this.versionDirectory(plugin, version));
    await atomicWrite(transaction, {
      schemaVersion: 1,
      plugin,
      fromVersion,
      toVersion: version,
      temporaryName,
      target,
    });
    await symlink(target, temporary);
    if (crashAfterPointerPrepared) {
      throw new Error('simulated activation crash after pointer preparation');
    }
    await rename(temporary, pointer);
    if (crashAfterPointerSwap) {
      throw new Error('simulated activation crash after pointer swap');
    }
    await unlink(transaction);
    return version;
  }

  async rollback(plugin, version) {
    return this.activate(plugin, version);
  }

  async lease(taskId, plugin, version, { crashAfterPrepare = false } = {}) {
    await this.verify(plugin, version);
    const file = this.leaseFile(taskId);
    if (await exists(file)) {
      const current = await readJson(file);
      assert.equal(current.plugin, plugin, `task ${taskId} already leases another plugin`);
      assert.equal(current.version, version, `task ${taskId} lease is immutable`);
      return current;
    }
    const temporary = `${file}${NEXT_MARKER}${process.pid}-${Math.random().toString(16).slice(2)}`;
    const value = { schemaVersion: 1, taskId, plugin, version };
    await writeFile(temporary, json(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (crashAfterPrepare) {
      throw new Error('simulated lease crash after prepare');
    }
    await rename(temporary, file);
    return value;
  }

  async releaseLease(taskId) {
    await unlink(this.leaseFile(taskId)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async recover() {
    const transactionFiles = (await readdir(this.transactionRoot)).filter((name) => name.endsWith('.json'));
    for (const name of transactionFiles) {
      const file = path.join(this.transactionRoot, name);
      const transaction = await readJson(file);
      const pointer = this.activePointer(transaction.plugin);
      const temporary = path.join(this.activeRoot, transaction.temporaryName);
      let current = null;
      if (await exists(pointer)) current = await this.activeVersion(transaction.plugin);
      if (current === transaction.toVersion) {
        await unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      } else if (current === transaction.fromVersion || current === null) {
        await unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      } else {
        // Unknown state: restore the last known-good version if possible.
        if (transaction.fromVersion) {
          await this.verify(transaction.plugin, transaction.fromVersion);
          const target = path.relative(this.activeRoot, this.versionDirectory(transaction.plugin, transaction.fromVersion));
          const fallback = path.join(this.activeRoot, `${transaction.plugin}${NEXT_MARKER}recovery-${process.pid}`);
          await symlink(target, fallback);
          await rename(fallback, pointer);
        } else {
          await unlink(pointer).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
        await unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      await unlink(file);
    }

    const leaseNames = await readdir(this.leaseRoot);
    for (const name of leaseNames.filter((entry) => entry.includes(NEXT_MARKER))) {
      const temporary = path.join(this.leaseRoot, name);
      const final = temporary.slice(0, temporary.indexOf(NEXT_MARKER));
      if (await exists(final)) {
        await unlink(temporary);
      } else {
        const lease = await readJson(temporary);
        await this.verify(lease.plugin, lease.version);
        await rename(temporary, final);
      }
    }

    for (const name of await readdir(this.activeRoot)) {
      if (name.includes(NEXT_MARKER)) await rm(path.join(this.activeRoot, name), { recursive: true, force: true });
    }
  }

  async leaseVersions(plugin) {
    const leases = await readdir(this.leaseRoot);
    const protectedVersions = new Set();
    for (const name of leases.filter((entry) => entry.endsWith('.json'))) {
      const value = await readJson(path.join(this.leaseRoot, name));
      assert.equal(value.schemaVersion, 1, `unknown lease schema in ${name}`);
      if (value.plugin !== plugin) continue;
      await this.verify(value.plugin, value.version);
      protectedVersions.add(value.version);
    }
    return protectedVersions;
  }

  async gc(plugin) {
    await this.recover();
    const cache = this.cacheDirectory(plugin);
    const entries = await readdir(cache, { withFileTypes: true });
    const versions = entries.filter((entry) => entry.isDirectory() && VERSION_PATTERN.test(entry.name)).map((entry) => entry.name);
    const active = await this.activeVersion(plugin);
    const protectedVersions = await this.leaseVersions(plugin);
    if (active) protectedVersions.add(active);
    const removed = [];
    for (const version of versions) {
      if (protectedVersions.has(version)) continue;
      await this.verify(plugin, version);
      await rm(this.versionDirectory(plugin, version), { recursive: true, force: true });
      removed.push(version);
    }
    return { removed: removed.sort(), retained: versions.filter((version) => !removed.includes(version)).sort() };
  }
}

async function runFixture() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-plugin-activation-fixture-'));
  const tempRoot = await realpath(temporaryRoot);
  const tempBase = await realpath(os.tmpdir());
  assert.ok(tempRoot === tempBase || tempRoot.startsWith(`${tempBase}${path.sep}`), 'fixture root must be under the system temp directory');
  const store = new ActivationFixture(tempRoot);
  await store.init();
  try {
    const v1 = await store.stage(PLUGIN, '1.0.0', { 'skill/SKILL.md': 'version one\n' });
    const v2 = await store.stage(PLUGIN, '2.0.0', { 'skill/SKILL.md': 'version two\n' });
    const v3 = await store.stage(PLUGIN, '3.0.0', { 'skill/SKILL.md': 'version three\n' });
    const v4 = await store.stage(PLUGIN, '4.0.0', { 'skill/SKILL.md': 'version four\n' });

    const stagedMode = (await lstat(path.join(v1.path, 'skill/SKILL.md'))).mode;
    assert.equal(stagedMode & 0o222, 0, 'staged files must be sealed read-only');
    await assert.rejects(() => store.stage(PLUGIN, '1.0.0', { 'skill/SKILL.md': 'replacement\n' }), /immutable/);
    await store.verify(PLUGIN, '1.0.0');

    await store.activate(PLUGIN, '1.0.0');
    assert.equal(await store.activeVersion(PLUGIN), '1.0.0');
    await store.lease('task-paused', PLUGIN, '1.0.0');

    await store.activate(PLUGIN, '2.0.0');
    assert.equal(await store.activeVersion(PLUGIN), '2.0.0');
    assert.equal((await readJson(store.leaseFile('task-paused'))).version, '1.0.0');

    await assert.rejects(
      () => store.activate(PLUGIN, '3.0.0', { crashAfterPointerPrepared: true }),
      /simulated activation crash/,
    );
    assert.equal(await store.activeVersion(PLUGIN), '2.0.0');
    assert.equal(await exists(store.transactionFile(PLUGIN)), true);
    await store.recover();
    assert.equal(await store.activeVersion(PLUGIN), '2.0.0', 'recovery must preserve the last active version');
    assert.equal((await readdir(store.activeRoot)).some((name) => name.includes(NEXT_MARKER)), false);

    await store.activate(PLUGIN, '3.0.0');
    assert.equal(await store.activeVersion(PLUGIN), '3.0.0');
    await assert.rejects(
      () => store.lease('task-restarting', PLUGIN, '4.0.0', { crashAfterPrepare: true }),
      /simulated lease crash/,
    );
    assert.equal(await exists(store.leaseFile('task-restarting')), false);
    await store.recover();
    assert.equal((await readJson(store.leaseFile('task-restarting'))).version, '4.0.0', 'recovery must retain a prepared lease');

    const firstGc = await store.gc(PLUGIN);
    assert.deepEqual(firstGc.removed, ['2.0.0'], 'GC may remove only inactive, unleased versions');
    assert.deepEqual(firstGc.retained, ['1.0.0', '3.0.0', '4.0.0']);

    await store.rollback(PLUGIN, '1.0.0');
    assert.equal(await store.activeVersion(PLUGIN), '1.0.0');
    const secondGc = await store.gc(PLUGIN);
    assert.deepEqual(secondGc.removed, ['3.0.0']);
    assert.deepEqual(secondGc.retained, ['1.0.0', '4.0.0']);

    await store.releaseLease('task-paused');
    await store.releaseLease('task-restarting');
    const finalGc = await store.gc(PLUGIN);
    assert.deepEqual(finalGc.removed, ['4.0.0']);
    assert.deepEqual(finalGc.retained, ['1.0.0']);
    process.stdout.write('plugin activation fixture passed (immutable staging, atomic activation, leases, recovery, rollback, and conservative GC)\n');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await runFixture();
