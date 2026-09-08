import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONSENT_GRANT_DURATION,
  CONSENT_GRANT_STORE_FILE,
  createConsentGrantStore,
} from '../mcp/v3/consent-grants.mjs';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' }).trim();
}

async function repository(root, name, origin = `https://example.test/${name}.git`) {
  const repo = path.join(root, name);
  await mkdir(repo);
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  git(repo, 'config', 'remote.origin.url', origin);
  await writeFile(path.join(repo, 'README.md'), `${name}\n`);
  git(repo, 'add', 'README.md');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
  return repo;
}

async function fixture(exercise) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-consent-grants-'));
  try { await exercise(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('remembered grants follow the Git common directory and exact provider subset', async () => {
  await fixture(async (root) => {
    const repo = await repository(root, 'repo');
    const linked = path.join(root, 'linked');
    git(repo, 'worktree', 'add', '--quiet', '-b', 'linked', linked);
    const state = path.join(root, 'state');
    const store = createConsentGrantStore({ root: state });
    await store.remember({ repositoryPath: repo, providers: ['cursor-local', 'grok'] });

    const linkedGrant = await store.lookup({ repositoryPath: linked, providers: ['grok'] });
    assert.equal(linkedGrant.duration, CONSENT_GRANT_DURATION);
    assert.equal(linkedGrant.source, 'durable_grant');
    assert.equal(await store.lookup({ repositoryPath: linked, providers: ['grok', 'dsh'] }), null);

    git(repo, 'config', 'remote.origin.url', 'https://example.test/changed.git');
    assert.equal(await store.lookup({ repositoryPath: repo, providers: ['grok'] }), null);
  });
});

test('unrelated and recreated repositories do not inherit remembered consent', async () => {
  await fixture(async (root) => {
    const repo = await repository(root, 'repo');
    const other = await repository(root, 'other', 'https://example.test/repo.git');
    const state = path.join(root, 'state');
    const store = createConsentGrantStore({ root: state });
    await store.remember({ repositoryPath: repo, providers: ['grok'] });
    assert.equal(await store.lookup({ repositoryPath: other, providers: ['grok'] }), null);

    await rm(repo, { recursive: true, force: true });
    const recreated = await repository(root, 'repo');
    assert.equal(await store.lookup({ repositoryPath: recreated, providers: ['grok'] }), null);
  });
});

test('grant persistence, provider union, and revocation are process-independent', async () => {
  await fixture(async (root) => {
    const repo = await repository(root, 'repo');
    const state = path.join(root, 'state');
    const first = createConsentGrantStore({ root: state });
    await Promise.all([
      first.remember({ repositoryPath: repo, providers: ['grok'] }),
      first.remember({ repositoryPath: repo, providers: ['dsh'] }),
    ]);
    const restarted = createConsentGrantStore({ root: state });
    assert.ok(await restarted.lookup({ repositoryPath: repo, providers: ['grok', 'dsh'] }));
    const [grant] = await restarted.list();
    assert.deepEqual(grant.providers, ['dsh', 'grok']);
    assert.equal(await restarted.revoke({ grantId: grant.grant_id }), true);
    assert.equal(await first.lookup({ repositoryPath: repo, providers: ['grok'] }), null,
      'an already-running process reloads state after CLI-style revocation');
  });
});

test('concurrent revoke and remember cannot resurrect an unrelated grant', async () => {
  await fixture(async (root) => {
    const repoA = await repository(root, 'repo-a');
    const repoB = await repository(root, 'repo-b');
    const state = path.join(root, 'state');
    const storeA = createConsentGrantStore({ root: state });
    const storeB = createConsentGrantStore({ root: state });
    await storeA.remember({ repositoryPath: repoA, providers: ['grok'] });
    await storeA.remember({ repositoryPath: repoB, providers: ['grok'] });
    const grantA = (await storeA.list()).find((grant) => grant.repository.includes('repo-a'));
    await Promise.all([
      storeA.revoke({ grantId: grantA.grant_id }),
      storeB.remember({ repositoryPath: repoB, providers: ['dsh'] }),
    ]);
    assert.equal(await storeA.lookup({ repositoryPath: repoA, providers: ['grok'] }), null);
    assert.ok(await storeA.lookup({ repositoryPath: repoB, providers: ['grok', 'dsh'] }));
  });
});

test('malformed and unsafe state fails closed without repair', async () => {
  await fixture(async (root) => {
    const repo = await repository(root, 'repo');
    const state = path.join(root, 'state');
    await mkdir(state, { mode: 0o700 });
    const file = path.join(state, CONSENT_GRANT_STORE_FILE);
    await writeFile(file, '{"schema":"wrong"}\n', { mode: 0o600 });
    const store = createConsentGrantStore({ root: state });
    await assert.rejects(store.lookup({ repositoryPath: repo, providers: ['grok'] }),
      { code: 'consent_grant_store_invalid' });
    assert.equal(await readFile(file, 'utf8'), '{"schema":"wrong"}\n');
    await chmod(file, 0o644);
    await assert.rejects(store.list(), { code: 'consent_grant_store_unsafe' });
  });
});
