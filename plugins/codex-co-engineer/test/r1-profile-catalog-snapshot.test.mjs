// Whole-catalog snapshot port tests (P04 follow-up, additive).
//
// loadProfileCatalogSnapshot must hand the run resolver one safe, immutable
// catalog snapshot: a single read of both scopes, deterministic name order,
// per-record provenance plus one whole-catalog digest binding, deep closure
// with no mutable Map/object escape, typed rejection of hostile direct-JS
// options, and zero filesystem rereads during resolution. Legacy
// loadProfiles/findProfile surfaces stay byte-compatible.

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PROFILE_SCHEMA,
  findProfile,
  loadProfileCatalogSnapshot,
  loadProfiles,
  profileProvenanceDigest,
} from '../mcp/v3/profile.mjs';

const validDefinition = (extra = {}) => ({
  schema: PROFILE_SCHEMA,
  provider: 'dsh',
  role: 'implement',
  expected_duration_ms: 1_200_000,
  ...extra,
});

const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

async function makeWorkspace({ project, owner } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'r1-profile-snap-'));
  const repositoryPath = path.join(root, 'repo');
  const ownerConfigDir = path.join(root, 'owner-config');
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(ownerConfigDir, { recursive: true });
  if (project !== undefined) {
    await writeJson(path.join(repositoryPath, '.codex', 'co-engineer-profiles.json'), project);
  }
  if (owner !== undefined) {
    const ownerFile = path.join(ownerConfigDir, 'codex-co-engineer', 'profiles.json');
    await writeJson(ownerFile, owner);
    await chmod(path.dirname(ownerFile), 0o700);
    await chmod(ownerFile, 0o600);
  }
  return {
    root,
    repositoryPath,
    ownerConfigDir,
    options: { repositoryPath, ownerConfigDir },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const expectCode = (code, label) => (error) => {
  assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code}: ${error.message}`);
  return true;
};

// Independent test-side closure audit (mirrors and exceeds the production
// proof): frozen everywhere, standard prototypes only, enumerable data
// properties only, and never a Map/Set/function escape.
function closureViolations(value, seen = new Set(), violations = []) {
  if (value === null || typeof value !== 'object') return violations;
  if (seen.has(value)) return violations;
  seen.add(value);
  if (!Object.isFrozen(value)) violations.push('unfrozen container');
  if (value instanceof Map || value instanceof Set) violations.push('mutable Map/Set escaped');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype && prototype !== null) violations.push('exotic array prototype');
    for (const entry of value) closureViolations(entry, seen, violations);
    return violations;
  }
  if (prototype !== Object.prototype && prototype !== null) violations.push('exotic object prototype');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) violations.push(`non-data key ${key}`);
    else closureViolations(descriptor.value, seen, violations);
  }
  return violations;
}

test('snapshot closes both catalogs into one deeply frozen, digest-bound result', async () => {
  const workspace = await makeWorkspace({
    project: {
      'run-profile': validDefinition({ model: 'stealth/ox-alpha', role: 'review', default: true }),
      'assign-a': validDefinition({ policy: { pre_dispatch_provider_preference: ['dsh', 'grok'] } }),
      shared: validDefinition(),
    },
    owner: { shared: validDefinition({ role: 'verify' }), 'owner-only': validDefinition() },
  });
  try {
    const snapshot = await loadProfileCatalogSnapshot(workspace.options);

    assert.deepEqual(Object.keys(snapshot),
      ['schema', 'catalog_digest', 'roots', 'sources', 'profiles', 'shadowed']);
    assert.equal(snapshot.schema, PROFILE_SCHEMA);
    assert.match(snapshot.catalog_digest, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(closureViolations(snapshot), []);

    // Deterministic name order across the merged two-scope catalog.
    assert.deepEqual(snapshot.profiles.map(({ name }) => name),
      ['assign-a', 'owner-only', 'run-profile', 'shared']);
    for (const record of snapshot.profiles) {
      assert.deepEqual(Object.keys(record), ['name', 'scope', 'source', 'definition', 'digest']);
      assert.equal(record.digest, profileProvenanceDigest({ name: record.name, definition: record.definition }));
      assert.equal(record.source,
        record.scope === 'project'
          ? path.join(workspace.repositoryPath, '.codex', 'co-engineer-profiles.json')
          : path.join(workspace.ownerConfigDir, 'codex-co-engineer', 'profiles.json'));
    }
    assert.equal(findProfile(snapshot, 'shared').definition.role, 'implement',
      'project precedence applies inside the snapshot');

    // Precedence losers stay visible and bound to their primary.
    assert.equal(snapshot.shadowed.length, 1);
    const shadowedRecord = snapshot.shadowed[0];
    assert.equal(shadowedRecord.name, 'shared');
    assert.equal(shadowedRecord.reason, 'project_scope_precedence');
    assert.equal(shadowedRecord.primary_digest, findProfile(snapshot, 'shared').digest);
    assert.deepEqual(Object.keys(shadowedRecord).sort(),
      ['definition', 'digest', 'name', 'primary_digest', 'reason', 'scope', 'source']);

    assert.deepEqual(snapshot.sources.map(({ scope, loaded }) => ({ scope, loaded })),
      [{ scope: 'project', loaded: true }, { scope: 'owner', loaded: true }]);
  } finally {
    await workspace.cleanup();
  }
});

test('resolution reuses one snapshot without rereading files or escaping mutables', async () => {
  const workspace = await makeWorkspace({
    project: {
      'run-profile': validDefinition({ role: 'review' }),
      'assign-a': validDefinition({ model: 'stealth/ox-alpha' }),
    },
    owner: { 'assign-b': validDefinition({ role: 'verify' }) },
  });
  let snapshot;
  try {
    snapshot = await loadProfileCatalogSnapshot(workspace.options);
    const expectedNames = ['run-profile', 'assign-a', 'assign-b'];
    const before = new Map(expectedNames.map((name) => [name, findProfile(snapshot, name)]));

    // Destroy every source file, then resolve the whole run from memory only:
    // a fresh load now sees nothing, while the snapshot still resolves all
    // profiles with byte-identical content - proof there was no reread.
    await rm(workspace.root, { recursive: true, force: true });
    for (const name of expectedNames) {
      assert.deepEqual(findProfile(snapshot, name), before.get(name));
    }
    const reread = await loadProfiles(workspace.options);
    assert.equal(reread.profiles.length, 0);
  } finally {
    if (snapshot === undefined) await workspace.cleanup();
  }

  // Frozen at every depth: mutation attempts fail loudly and change nothing.
  assert.throws(() => { snapshot.extra = 1; }, TypeError);
  assert.throws(() => { snapshot.profiles[0] = undefined; }, TypeError);
  assert.throws(() => { snapshot.profiles[0].name = 'renamed'; }, TypeError);
  assert.throws(() => { snapshot.profiles[0].definition.role = 'verify'; }, TypeError);
  assert.deepEqual(closureViolations(snapshot), []);
});

test('hostile direct-JS options fail typed before any catalog access', async () => {
  const options = { repositoryPath: '/repo', ownerConfigDir: '/owner-config' };

  const traps = ['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'];
  const observed = Object.fromEntries(traps.map((trap) => [trap, 0]));
  const liveProxy = new Proxy(options, new Proxy({}, {
    get(_targets, trap) {
      observed[trap] += 1;
      return Reflect.get(...arguments);
    },
  }));
  await assert.rejects(() => loadProfileCatalogSnapshot(liveProxy),
    expectCode('profile_proxy_rejected', 'live Proxy options'));
  for (const trap of traps) assert.equal(observed[trap], 0, `${trap} must stay unobserved`);

  const revoked = Proxy.revocable(options, {});
  revoked.revoke();
  await assert.rejects(() => loadProfileCatalogSnapshot(revoked.proxy),
    expectCode('profile_proxy_rejected', 'revoked Proxy options'));

  let optionReads = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, 'repositoryPath', {
    enumerable: true,
    get() { optionReads += 1; return '/repo'; },
  });
  await assert.rejects(() => loadProfileCatalogSnapshot(accessorOptions),
    expectCode('invalid_profile_options', 'accessor options'));
  assert.equal(optionReads, 0);

  await assert.rejects(() => loadProfileCatalogSnapshot(null), expectCode('invalid_profile_options', 'null options'));
  await assert.rejects(() => loadProfileCatalogSnapshot(7), expectCode('invalid_profile_options', 'numeric options'));
  await assert.rejects(
    () => loadProfileCatalogSnapshot({ repositoryPath: '/repo', env: null }),
    expectCode('invalid_profile_environment', 'null environment'),
  );
});

test('the catalog digest binds content, precedence, presence, and origin', async () => {
  const project = { alpha: validDefinition(), beta: validDefinition({ role: 'review' }) };
  const first = await makeWorkspace({ project, owner: { gamma: validDefinition() } });
  const sameContent = await makeWorkspace({ project, owner: { gamma: validDefinition() } });
  const reformatted = await makeWorkspace({
    project: { beta: validDefinition({ role: 'review' }), alpha: validDefinition() },
    owner: { gamma: validDefinition() },
  });
  const driftedModel = await makeWorkspace({
    project: { alpha: validDefinition(), beta: validDefinition({ role: 'review', model: 'future-dsh-model' }) },
    owner: { gamma: validDefinition() },
  });
  const extraOwnerEntry = await makeWorkspace({
    project, owner: { gamma: validDefinition(), delta: validDefinition() },
  });
  const missingOwnerFile = await makeWorkspace({ project });

  try {
    const baseline = await loadProfileCatalogSnapshot(first.options);
    assert.equal((await loadProfileCatalogSnapshot(first.options)).catalog_digest, baseline.catalog_digest,
      'reloading identical content is stable');

    // Key order and formatting are not content: rewriting the same catalog in
    // place keeps every canonical record digest and the whole-catalog binding
    // byte-identical, with deterministic name order regardless of JSON key
    // order.
    const reordered = await loadProfileCatalogSnapshot(reformatted.options);
    assert.deepEqual(reordered.profiles.map(({ digest }) => digest),
      baseline.profiles.map(({ digest }) => digest));
    assert.deepEqual(reordered.profiles.map(({ name }) => name),
      baseline.profiles.map(({ name }) => name));
    await writeJson(path.join(first.repositoryPath, '.codex', 'co-engineer-profiles.json'),
      { beta: validDefinition({ role: 'review' }), alpha: validDefinition() });
    const rewritten = await loadProfileCatalogSnapshot(first.options);
    assert.equal(rewritten.catalog_digest, baseline.catalog_digest,
      'formatting and key order never change the bound catalog identity');
    assert.deepEqual(rewritten.profiles, baseline.profiles);

    const digests = [];
    for (const workspace of [driftedModel, extraOwnerEntry, missingOwnerFile]) {
      digests.push((await loadProfileCatalogSnapshot(workspace.options)).catalog_digest);
    }
    for (const digest of digests) assert.notEqual(digest, baseline.catalog_digest);
    assert.equal(new Set(digests).size, digests.length, 'each drift axis binds independently');

    // Origin-awareness is catalog-level only: moving the same content keeps
    // every per-record provenance digest stable while flipping the snapshot
    // digest that binds where it was loaded from.
    const moved = await loadProfileCatalogSnapshot(sameContent.options);
    assert.notEqual(moved.catalog_digest, baseline.catalog_digest);
    assert.deepEqual(moved.profiles.map(({ digest }) => digest),
      baseline.profiles.map(({ digest }) => digest));

    // Shadowing changes the bound catalog even when every definition is old.
    const shadowing = await makeWorkspace({ project: { gamma: validDefinition() }, owner: { gamma: validDefinition() } });
    try {
      const shadowedSnapshot = await loadProfileCatalogSnapshot(shadowing.options);
      assert.notEqual(shadowedSnapshot.catalog_digest, baseline.catalog_digest);
      assert.equal(shadowedSnapshot.shadowed.length, 1);
    } finally {
      await shadowing.cleanup();
    }
  } finally {
    for (const workspace of [first, sameContent, reformatted, driftedModel, extraOwnerEntry, missingOwnerFile]) {
      await workspace.cleanup();
    }
  }
});

test('a fully loaded two-scope catalog snapshots closed at the merged bound', async () => {
  const project = {};
  const owner = {};
  for (let index = 0; index < 64; index += 1) {
    project[`p-${String(index).padStart(2, '0')}`] = validDefinition();
    owner[`o-${String(index).padStart(2, '0')}`] = validDefinition();
  }
  const workspace = await makeWorkspace({ project, owner });
  try {
    const snapshot = await loadProfileCatalogSnapshot(workspace.options);
    assert.equal(snapshot.profiles.length, 128);
    assert.deepEqual([...snapshot.profiles].map(({ name }) => name),
      [...snapshot.profiles].map(({ name }) => name).sort());
    assert.deepEqual(closureViolations(snapshot), []);
    assert.equal(findProfile(snapshot, 'p-00').scope, 'project');
    assert.equal(findProfile(snapshot, 'o-63').scope, 'owner');
  } finally {
    await workspace.cleanup();
  }
});

test('legacy loadProfiles/findProfile surfaces stay unchanged beside the snapshot', async () => {
  const workspace = await makeWorkspace({ project: { legacy: validDefinition() } });
  try {
    const loaded = await loadProfiles(workspace.options);
    assert.deepEqual(Object.keys(loaded), ['roots', 'profiles', 'shadowed', 'sources']);
    assert.deepEqual(Object.keys(loaded.profiles[0]),
      ['name', 'scope', 'source', 'definition', 'digest']);

    const snapshot = await loadProfileCatalogSnapshot(workspace.options);
    assert.notEqual(snapshot, loaded);
    assert.deepEqual(findProfile(snapshot, 'legacy'), findProfile(loaded, 'legacy'));
  } finally {
    await workspace.cleanup();
  }
});
