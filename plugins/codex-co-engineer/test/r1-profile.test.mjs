import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_PROFILES_PER_CATALOG,
  MAX_PROFILE_CATALOG_BYTES,
  PROFILE_SCHEMA,
  canonicalProfileJson,
  findProfile,
  loadProfiles,
  profileProvenanceDigest,
  profileRoots,
  validateProfileDefinition,
} from '../mcp/v3/profile.mjs';

const validDefinition = () => ({
  schema: PROFILE_SCHEMA,
  provider: 'dsh',
  role: 'implement',
  expected_duration_ms: 1_200_000,
});

const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

async function makeWorkspace({ project, owner } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'r1-profile-'));
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

test('profile roots are explicit and reject relative or traversal paths', () => {
  const roots = profileRoots({ repositoryPath: '/repo', ownerConfigDir: '/owner-config' });
  assert.equal(roots.project.file, path.join('/repo', '.codex', 'co-engineer-profiles.json'));
  assert.equal(roots.owner.file, path.join('/owner-config', 'codex-co-engineer', 'profiles.json'));
  assert.equal(roots.project.scope, 'project');
  assert.equal(roots.owner.scope, 'owner');

  const envRoots = profileRoots({ repositoryPath: '/repo', env: { XDG_CONFIG_HOME: '/xdg' } });
  assert.equal(envRoots.owner.file, path.join('/xdg', 'codex-co-engineer', 'profiles.json'));
  const homeRoots = profileRoots({ repositoryPath: '/repo', env: { HOME: '/home/test-user' } });
  assert.equal(homeRoots.owner.file, path.join('/home/test-user/.config', 'codex-co-engineer', 'profiles.json'));
  const relativeXdg = profileRoots({
    repositoryPath: '/repo',
    env: { XDG_CONFIG_HOME: 'relative/config', HOME: '/home/test-user' },
  });
  assert.equal(relativeXdg.owner.file, path.join('/home/test-user/.config', 'codex-co-engineer', 'profiles.json'));

  for (const bad of ['relative/repo', '/repo/../elsewhere', '.', '', undefined, 7]) {
    assert.throws(
      () => profileRoots({ repositoryPath: bad }),
      (error) => error.code === 'invalid_profile_repository_path',
      `repositoryPath ${String(bad)} must be rejected`,
    );
  }
  for (const bad of ['owner', '/owner/../other', '']) {
    assert.throws(
      () => profileRoots({ repositoryPath: '/repo', ownerConfigDir: bad }),
      (error) => error.code === 'invalid_profile_owner_config_dir',
      `ownerConfigDir ${String(bad)} must be rejected`,
    );
  }
});

test('profile name grammar is ^[a-z0-9][a-z0-9._-]{0,63}$', async () => {
  const { options, cleanup } = await makeWorkspace();
  try {
    const catalog = {};
    for (const name of ['deep-security-review', 'a', '0', 'x.y_z-9', 'trailing.', 'a'.repeat(64)]) catalog[name] = validDefinition();
    await writeJson(path.join(options.repositoryPath, '.codex', 'co-engineer-profiles.json'), catalog);
    const loaded = await loadProfiles(options);
    assert.equal(loaded.profiles.length, 6);
  } finally {
    await cleanup();
  }

  for (const name of [
    'Upper', '.leading', '-leading', '_leading', 'has space', 'slash/path', 'back\\slash',
    'a'.repeat(65), '', 'a..b/../trap', '/etc/passwd', 'c:\\path', 'uni-é',
  ]) {
    const { options: opts, cleanup: done } = await makeWorkspace();
    try {
      await writeJson(path.join(opts.repositoryPath, '.codex', 'co-engineer-profiles.json'), { [name]: validDefinition() });
      await assert.rejects(
        () => loadProfiles(opts),
        (error) => error.code === 'invalid_profile_name',
        `profile name ${String(name)} must be rejected`,
      );
    } finally {
      await done();
    }
  }
});

test('loadProfiles merges owner and project catalogs deterministically', async () => {
  const { options, cleanup } = await makeWorkspace({
    project: { 'b-review': validDefinition(), 'a-implement': validDefinition() },
    owner: { 'z-owner-default': validDefinition(), 'a-implement': validDefinition() },
  });
  try {
    const first = await loadProfiles(options);
    const second = await loadProfiles(options);
    assert.deepEqual(first, second, 'loading the same inputs must be deterministic');

    assert.deepEqual(first.profiles.map((record) => record.name), ['a-implement', 'b-review', 'z-owner-default']);
    assert.equal(findProfile(first, 'a-implement').scope, 'project', 'project scope must take precedence');
    assert.equal(findProfile(first, 'z-owner-default').scope, 'owner');
    assert.deepEqual(first.sources.map(({ scope, loaded }) => ({ scope, loaded })), [
      { scope: 'project', loaded: true },
      { scope: 'owner', loaded: true },
    ]);

    const shadowed = first.shadowed.find((record) => record.name === 'a-implement');
    assert.ok(shadowed, 'the shadowed owner record must be reported');
    assert.equal(shadowed.scope, 'owner');
    assert.equal(shadowed.reason, 'project_scope_precedence');
    assert.equal(shadowed.primary_digest, findProfile(first, 'a-implement').digest);

    for (const record of first.profiles) {
      assert.equal(record.definition.schema, PROFILE_SCHEMA);
      assert.match(record.digest, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(record.source, record.scope === 'project'
        ? path.join(options.repositoryPath, '.codex', 'co-engineer-profiles.json')
        : path.join(options.ownerConfigDir, 'codex-co-engineer', 'profiles.json'));
      assert.ok(Object.isFrozen(record.definition));
    }
  } finally {
    await cleanup();
  }
});

test('missing catalogs load as empty and lookups stay exact', async () => {
  const { options, cleanup } = await makeWorkspace();
  try {
    const loaded = await loadProfiles(options);
    assert.deepEqual(loaded.profiles, []);
    assert.deepEqual(loaded.shadowed, []);
    assert.deepEqual(loaded.sources.map(({ scope, loaded: present }) => ({ scope, loaded: present })), [
      { scope: 'project', loaded: false },
      { scope: 'owner', loaded: false },
    ]);
    assert.equal(findProfile(loaded, 'anything'), undefined);
    assert.throws(() => findProfile(loaded, 'Not-A-Name'), (error) => error.code === 'invalid_profile_name');
  } finally {
    await cleanup();
  }
});

test('provenance digest is stable over canonical data', async () => {
  const definition = validDefinition();
  const base = profileProvenanceDigest({ name: 'profile-a', definition });
  const reordered = profileProvenanceDigest({
    name: 'profile-a',
    definition: { expected_duration_ms: 1_200_000, role: 'implement', provider: 'dsh', schema: PROFILE_SCHEMA },
  });
  assert.equal(base, reordered, 'key order must not change the digest');
  assert.equal(base, profileProvenanceDigest({ name: 'profile-a', definition: { ...definition } }));

  assert.notEqual(base, profileProvenanceDigest({ name: 'profile-b', definition }));
  assert.notEqual(base, profileProvenanceDigest({
    name: 'profile-a',
    definition: { ...definition, provider: 'grok' },
  }));

  const parsed = JSON.parse(canonicalProfileJson({ z: [1, { b: 2, a: 1 }], a: 1 }));
  assert.deepEqual(parsed, { a: 1, z: [1, { a: 1, b: 2 }] });
  assert.equal(canonicalProfileJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('catalog files must be regular, bounded, and structurally sound', async () => {
  const base = await makeWorkspace();
  try {
    const { options, repositoryPath, cleanup } = base;
    const catalogPath = path.join(repositoryPath, '.codex', 'co-engineer-profiles.json');

    await mkdir(catalogPath, { recursive: true });
    await assert.rejects(() => loadProfiles(options), (error) => error.code === 'profile_catalog_not_regular');
    await rm(catalogPath, { recursive: true, force: true });

    await writeJson(catalogPath, {});
    await symlink(catalogPath, `${catalogPath}.link`);
    await rm(catalogPath);
    await symlink(catalogPath, catalogPath);
    await assert.rejects(() => loadProfiles(options), (error) => error.code === 'profile_catalog_not_regular');
    await rm(catalogPath);

    await writeFile(catalogPath, 'x'.repeat(MAX_PROFILE_CATALOG_BYTES + 1));
    await assert.rejects(() => loadProfiles(options), (error) => error.code === 'profile_catalog_too_large');
    await rm(catalogPath);

    const cases = [
      ['[]', 'invalid_profile_catalog_shape'],
      ['"text"', 'invalid_profile_catalog_shape'],
      ['{"a":}', 'invalid_profile_catalog_json'],
      ['{"a":1,"a":2}', 'duplicate_profile_key'],
      ['{"a":{"x":1},"b":{"x":1,"x":2}}', 'duplicate_profile_key'],
    ];
    for (const [text, code] of cases) {
      await writeFile(catalogPath, text);
      await assert.rejects(() => loadProfiles(options), (error) => error.code === code, `${text} must fail ${code}`);
    }
    await writeFile(catalogPath, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]));
    await assert.rejects(
      () => loadProfiles(options),
      (error) => error.code === 'invalid_profile_catalog_encoding',
      'invalid UTF-8 must never be replacement-decoded',
    );

    const tooMany = {};
    for (let index = 0; index <= MAX_PROFILES_PER_CATALOG; index += 1) {
      tooMany[`profile-${String(index).padStart(2, '0')}`] = validDefinition();
    }
    await writeJson(catalogPath, tooMany);
    await assert.rejects(() => loadProfiles(options), (error) => error.code === 'profile_catalog_too_many_entries');
    await cleanup();
  } finally {
    await base.cleanup();
  }
});

test('catalog special files are rejected without blocking before fstat', {
  skip: process.platform !== 'linux',
  timeout: 2_000,
}, async () => {
  const workspace = await makeWorkspace();
  try {
    const catalogPath = path.join(
      workspace.repositoryPath,
      '.codex',
      'co-engineer-profiles.json',
    );
    await mkdir(path.dirname(catalogPath), { recursive: true });
    execFileSync('mkfifo', [catalogPath], { stdio: 'ignore' });
    await assert.rejects(
      () => loadProfiles(workspace.options),
      (error) => error.code === 'profile_catalog_not_regular',
    );
  } finally {
    await workspace.cleanup();
  }
});

test('owner catalogs reject group- or world-writable control surfaces', async () => {
  const { options, ownerConfigDir, cleanup } = await makeWorkspace({ owner: { secure: validDefinition() } });
  try {
    const ownerCatalog = path.join(ownerConfigDir, 'codex-co-engineer', 'profiles.json');
    await chmod(ownerCatalog, 0o666);
    await assert.rejects(
      () => loadProfiles(options),
      (error) => error.code === 'profile_catalog_not_owner_controlled',
    );
  } finally {
    await cleanup();
  }
});

test('definitions must be objects declaring the ProfileV1 schema', async () => {
  const { options, repositoryPath, cleanup } = await makeWorkspace();
  try {
    const catalogPath = path.join(repositoryPath, '.codex', 'co-engineer-profiles.json');
    const cases = [
      [{ a: null }, 'invalid_profile_definition'],
      [{ a: [PROFILE_SCHEMA] }, 'invalid_profile_definition'],
      [{ a: {} }, 'invalid_profile_schema'],
      [{ a: { schema: 'codex-co-engineer.profile.v2' } }, 'invalid_profile_schema'],
      [{ a: { schema: PROFILE_SCHEMA, provider: 7 } }, 'unsupported_profile_provider'],
    ];
    for (const [catalog, code] of cases) {
      await writeJson(catalogPath, catalog);
      await assert.rejects(() => loadProfiles(options), (error) => error.code === code);
    }
  } finally {
    await cleanup();
  }
});

test('provider, model, and role fields validate against the 3.2.1 routes', async () => {
  const { options, repositoryPath, cleanup } = await makeWorkspace();
  try {
    const catalogPath = path.join(repositoryPath, '.codex', 'co-engineer-profiles.json');
    const write = (definition) => writeJson(catalogPath, { probe: definition });

    for (const provider of ['dsh', 'grok', 'cursor-local', 'cursor-cloud']) {
      await write({ schema: PROFILE_SCHEMA, provider });
      const loaded = await loadProfiles(options);
      assert.equal(findProfile(loaded, 'probe').definition.provider, provider);
    }
    for (const model of ['muse-spark-1.2-contributor', 'stealth/ox-alpha']) {
      await write({ schema: PROFILE_SCHEMA, provider: 'dsh', model });
      assert.equal((await loadProfiles(options)).profiles[0].definition.model, model);
    }
    for (const role of ['review', 'implement']) {
      await write({ schema: PROFILE_SCHEMA, provider: 'dsh', role });
      assert.equal((await loadProfiles(options)).profiles[0].definition.role, role);
    }

    const cases = [
      [{ schema: PROFILE_SCHEMA, provider: 'claude' }, 'unsupported_profile_provider'],
      [{ schema: PROFILE_SCHEMA, provider: 'DSH' }, 'unsupported_profile_provider'],
      [{ schema: PROFILE_SCHEMA, provider: 'dsh', model: 'gpt-9' }, 'unknown_profile_model'],
      [{ schema: PROFILE_SCHEMA, provider: 'dsh', model: 'stealth/../../ox' }, 'invalid_profile_model'],
      [{ schema: PROFILE_SCHEMA, provider: 'dsh', model: `${'a'.repeat(60)}!${'a'.repeat(68)}` }, 'invalid_profile_model'],
      [{ schema: PROFILE_SCHEMA, provider: 'grok', model: 'grok-4' }, 'invalid_profile_model_for_provider'],
      [{ schema: PROFILE_SCHEMA, model: 'stealth/ox-alpha' }, 'invalid_profile_model_for_provider'],
      [{ schema: PROFILE_SCHEMA, provider: 'dsh', role: 'orchestrate' }, 'unsupported_profile_role'],
      [{ schema: PROFILE_SCHEMA, provider: 'dsh', expected_duration_ms: 999 }, 'invalid_profile_expected_duration_ms'],
      [{ schema: PROFILE_SCHEMA, provider: 'dsh', expected_duration_ms: 86_400_001 }, 'invalid_profile_expected_duration_ms'],
      [{ schema: PROFILE_SCHEMA, provider: 'dsh', expected_duration_ms: 1.5 }, 'invalid_profile_expected_duration_ms'],
    ];
    for (const [definition, code] of cases) {
      await write(definition);
      await assert.rejects(() => loadProfiles(options), (error) => error.code === code, JSON.stringify(definition));
    }
  } finally {
    await cleanup();
  }
});

test('policy data stays bounded, non-executable, and deterministic', async () => {
  const { options, repositoryPath, cleanup } = await makeWorkspace();
  try {
    const catalogPath = path.join(repositoryPath, '.codex', 'co-engineer-profiles.json');
    const write = (definition) => writeJson(catalogPath, { probe: definition });

    await write({
      schema: PROFILE_SCHEMA,
      provider: 'dsh',
      policy: { pre_dispatch_provider_preference: ['dsh', 'grok', 'cursor-local', 'cursor-cloud'] },
    });
    const loaded = await loadProfiles(options);
    assert.deepEqual(loaded.profiles[0].definition.policy.pre_dispatch_provider_preference,
      ['dsh', 'grok', 'cursor-local', 'cursor-cloud'], 'authored preference order must be preserved');
    assert.ok(Object.isFrozen(loaded.profiles[0].definition.policy));
    assert.ok(Object.isFrozen(loaded.profiles[0].definition.policy.pre_dispatch_provider_preference));
    assert.throws(
      () => loaded.profiles[0].definition.policy.pre_dispatch_provider_preference.push('dsh'),
      TypeError,
      'validated nested profile data must be immutable',
    );

    const cases = [
      [{ schema: PROFILE_SCHEMA, policy: 'fast' }, 'invalid_profile_policy'],
      [{ schema: PROFILE_SCHEMA, policy: [] }, 'invalid_profile_policy'],
      [{ schema: PROFILE_SCHEMA, policy: {} , extra: 1 }, 'unknown_profile_field'],
      [{ schema: PROFILE_SCHEMA, policy: { commands: ['npm', 'test'] } }, 'profile_executable_key_rejected'],
      [{ schema: PROFILE_SCHEMA, policy: { executable: '/usr/bin/npm' } }, 'profile_executable_key_rejected'],
      [{ schema: PROFILE_SCHEMA, policy: { argv_template: ['test'] } }, 'profile_executable_key_rejected'],
      [{ schema: PROFILE_SCHEMA, policy: { verification_commands: [] } }, 'profile_executable_key_rejected'],
      [{ schema: PROFILE_SCHEMA, policy: { environment: { CI: '1' } } }, 'profile_environment_key_rejected'],
      [{ schema: PROFILE_SCHEMA, policy: { allow_merge: true } }, 'profile_authority_key_rejected'],
      [{ schema: PROFILE_SCHEMA, policy: { create_pr: true } }, 'profile_authority_key_rejected'],
      [{ schema: PROFILE_SCHEMA, policy: { workspace_mode: 'direct' } }, 'profile_direct_mode_key_rejected'],
      // The deep value scan runs first: 'main' is itself a moving-ref name.
      [{ schema: PROFILE_SCHEMA, policy: { branch: 'release-1.2' } }, 'profile_moving_ref_key_rejected'],
      [{ schema: PROFILE_SCHEMA, policy: { branch: 'main' } }, 'profile_moving_ref_value_rejected'],
      [{ schema: PROFILE_SCHEMA, policy: { prompt: 'do things' } }, 'profile_embedded_content_key_rejected'],
      [{ schema: PROFILE_SCHEMA, policy: { unknown_thing: 1 } }, 'unknown_profile_policy_field'],
      [{ schema: PROFILE_SCHEMA, policy: { pre_dispatch_provider_preference: [] } }, 'invalid_profile_provider_preference'],
      [{ schema: PROFILE_SCHEMA, policy: { pre_dispatch_provider_preference: ['dsh', 7] } }, 'invalid_profile_provider_preference'],
      [{ schema: PROFILE_SCHEMA, policy: { pre_dispatch_provider_preference: ['dsh', 'claude'] } }, 'unsupported_profile_provider'],
      [{ schema: PROFILE_SCHEMA, policy: { pre_dispatch_provider_preference: ['dsh', 'dsh'] } }, 'duplicate_profile_preference_provider'],
      [{ schema: PROFILE_SCHEMA, policy: { pre_dispatch_provider_preference: ['dsh', 'grok', 'cursor-local', 'cursor-cloud', 'dsh'] } }, 'invalid_profile_provider_preference'],
    ];
    for (const [definition, code] of cases) {
      await write(definition);
      await assert.rejects(() => loadProfiles(options), (error) => error.code === code, JSON.stringify(definition));
    }
  } finally {
    await cleanup();
  }
});

test('unknown keys are rejected and dangerous values never survive validation', async () => {
  const { options, repositoryPath, cleanup } = await makeWorkspace();
  try {
    const catalogPath = path.join(repositoryPath, '.codex', 'co-engineer-profiles.json');
    const write = (definition) => writeJson(catalogPath, { probe: definition });

    const cases = [
      ['credential key', { schema: PROFILE_SCHEMA, provider: 'dsh', api_key: 'x' }, 'profile_credential_key_rejected'],
      ['credential token', { schema: PROFILE_SCHEMA, provider: 'dsh', 'access-token': 'x' }, 'profile_credential_key_rejected'],
      ['secret value', { schema: PROFILE_SCHEMA, provider: 'dsh', role: 'review', model: 'sk-abcdefghijklmnop' }, 'profile_secret_value_rejected'],
      ['env interpolation', { schema: PROFILE_SCHEMA, provider: 'dsh', role: 'review', model: '${DSH_MODEL}' }, 'profile_environment_value_rejected'],
      ['shell value', { schema: PROFILE_SCHEMA, provider: 'dsh', role: 'review', model: 'a; rm -rf' }, 'profile_shell_value_rejected'],
      ['moving ref value', { schema: PROFILE_SCHEMA, provider: 'dsh', role: 'review', model: 'refs/heads/main' }, 'profile_moving_ref_value_rejected'],
    ];
    for (const [label, definition, code] of cases) {
      await write(definition);
      await assert.rejects(() => loadProfiles(options), (error) => error.code === code, label);
    }
  } finally {
    await cleanup();
  }
});

test('live and revoked Proxy views are rejected with typed codes before any inspection', () => {
  const definition = validDefinition();
  const transparent = new Proxy(definition, {});
  const revoked = Proxy.revocable(definition, {});
  revoked.revoke();

  for (const hostile of [transparent, revoked.proxy]) {
    for (const run of [
      () => validateProfileDefinition('hostile', hostile),
      () => canonicalProfileJson(hostile),
      () => profileProvenanceDigest({ name: 'hostile', definition: hostile }),
      () => profileRoots(hostile),
      () => findProfile(hostile, 'anything'),
    ]) {
      assert.throws(run, (error) => error.code === 'profile_proxy_rejected',
        'every direct-JS surface must reject Proxy views with the typed code');
    }
  }

  // Revoked Proxies make even Array.isArray throw natively; rejection had to
  // happen before that target-inspecting builtin could run.
  assert.throws(() => Array.isArray(revoked.proxy), TypeError);

  // Ordinary static data is untouched by the boundary.
  const policy = { pre_dispatch_provider_preference: ['dsh'] };
  const withPolicy = { ...definition, policy };
  const frozen = Object.freeze({
    ...withPolicy,
    policy: Object.freeze({ ...policy,
      pre_dispatch_provider_preference: Object.freeze([...policy.pre_dispatch_provider_preference]) }),
  });
  const baseline = profileProvenanceDigest({ name: 'static-data', definition: withPolicy });
  assert.equal(baseline, profileProvenanceDigest({ name: 'static-data', definition: frozen }),
    'frozen and plain static views must produce identical digests');
  assert.ok(Object.isFrozen(validateProfileDefinition('static-data', frozen)));
});

test('digest inputs are closed over validated ProfileV1 data only', () => {
  const base = validDefinition();
  // Hidden own content can never reach the hash.
  const hidden = { ...base };
  Object.defineProperty(hidden, 'api_key', { enumerable: false, value: 'sk-hidden' });
  assert.throws(
    () => profileProvenanceDigest({ name: 'hidden-key', definition: hidden }),
    (error) => error.code === 'invalid_profile_definition',
    'non-enumerable properties must be rejected, not ignored',
  );

  let accessorReads = 0;
  const accessor = { ...base };
  Object.defineProperty(accessor, 'role', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'review';
    },
  });
  assert.throws(
    () => profileProvenanceDigest({ name: 'accessor-key', definition: accessor }),
    (error) => error.code === 'invalid_profile_definition',
    'accessor properties must be rejected without being read',
  );
  assert.equal(accessorReads, 0);

  const symbolKeyed = { ...base };
  symbolKeyed[Symbol('merge_authority')] = true;
  assert.throws(
    () => profileProvenanceDigest({ name: 'symbol-key', definition: symbolKeyed }),
    (error) => error.code === 'invalid_profile_definition',
    'symbol-keyed content must be rejected',
  );

  // Arbitrary or dangerous payloads cannot be laundered into provenance:
  // full ProfileV1 validation gates every digest.
  for (const [definition, code] of [
    [{ schema: PROFILE_SCHEMA, provider: 'dsh', api_key: 'sk-x' }, 'profile_credential_key_rejected'],
    [{ schema: PROFILE_SCHEMA, provider: 'dsh', unknown_field: 1 }, 'unknown_profile_field'],
    [{ schema: PROFILE_SCHEMA, provider: 'dsh', policy: { unknown_policy_field: 1 } }, 'unknown_profile_policy_field'],
    [{ schema: PROFILE_SCHEMA, provider: 'dsh', role: 'orchestrate' }, 'unsupported_profile_role'],
    [{}, 'invalid_profile_schema'],
  ]) {
    assert.throws(
      () => profileProvenanceDigest({ name: 'laundered', definition }),
      (error) => error.code === code,
      `${code} must gate the digest`,
    );
  }
});

test('findProfile and profileRoots consume arguments as one static snapshot', async () => {
  // Accessor-bearing results fail typed without ever reading through getters.
  let getterReads = 0;
  const accessorLoaded = {};
  Object.defineProperty(accessorLoaded, 'profiles', {
    enumerable: true,
    get() {
      getterReads += 1;
      return [];
    },
  });
  assert.throws(
    () => findProfile(accessorLoaded, 'anything'),
    (error) => error.code === 'invalid_profile_load_result',
    'accessor profiles lists must be rejected',
  );
  assert.equal(getterReads, 0);

  // A well-formed static result still resolves by exact name and preserves
  // record identity.
  const record = Object.freeze({
    name: 'probe',
    scope: 'project',
    definition: Object.freeze(validDefinition()),
    digest: `sha256:${'0'.repeat(64)}`,
  });
  const loaded = Object.freeze({ profiles: Object.freeze([record]), shadowed: [], sources: [] });
  assert.equal(findProfile(loaded, 'probe'), record);
  assert.equal(findProfile(loaded, 'missing'), undefined);

  // Malformed records fail closed instead of returning partial matches.
  for (const badList of [[{ provider: 'dsh' }], [{ name: 7 }], new Array(8)]) {
    assert.throws(
      () => findProfile({ profiles: badList }, 'probe'),
      (error) => error.code === 'invalid_profile_load_result',
      `malformed list ${JSON.stringify(badList)} must be rejected`,
    );
  }

  // Argument objects are inspected as snapshots, never dereferenced.
  let optionReads = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, 'repositoryPath', {
    enumerable: true,
    get() {
      optionReads += 1;
      return '/repo';
    },
  });
  assert.throws(
    () => profileRoots(accessorOptions),
    (error) => error.code === 'invalid_profile_options',
    'accessor-bearing root arguments must be rejected',
  );
  assert.equal(optionReads, 0);
  assert.throws(() => profileRoots(null), (error) => error.code === 'invalid_profile_options');
  assert.throws(
    () => profileProvenanceDigest(null),
    (error) => error.code === 'invalid_profile_provenance_payload',
  );
});

test('environment views are snapshotted per key without changing fallback order', () => {
  assert.throws(
    () => profileRoots({ repositoryPath: '/repo', env: new Proxy(process.env, {}) }),
    (error) => error.code === 'profile_proxy_rejected',
    'proxy environment views are rejected before any property access',
  );
  let envReads = 0;
  const countingEnv = new Proxy({}, {
    get(_target, key) {
      envReads += 1;
      return undefined;
    },
  });
  // A plain static environment keeps the documented XDG/HOME behavior.
  assert.equal(profileRoots({ repositoryPath: '/repo', env: {} }).owner.file,
    path.join(homedir(), '.config', 'codex-co-engineer', 'profiles.json'));
  assert.equal(profileRoots({ repositoryPath: '/repo', env: { XDG_CONFIG_HOME: '/xdg' } }).owner.file,
    path.join('/xdg', 'codex-co-engineer', 'profiles.json'));
  assert.equal(envReads, 0, 'environment fallback must not rely on property access');
});
