// P04 prerequisite-repair drift suite (fresh reconstruction).
//
// Binds ProfileV1 to the bounded run grammar it mirrors - one provider->model
// grammar across all four exact providers, requested-bytes syntax/size only,
// read-only verify in the role vocabulary, deprecated informational-only
// PROFILE_DSH_MODELS, and the primitive-true optional default flag - while
// proving the mirror never becomes an import dependency: the profile module
// stays import-free of the P02 run-manifest runtime and parity is asserted
// here against shared fixtures consumed by BOTH sides of the contract.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ALLOWED_PROFILE_FIELDS,
  MAX_PROVIDER_PREFERENCE_ENTRIES,
  PROFILE_DSH_MODELS,
  PROFILE_MODEL_ID_MAX_BYTES,
  PROFILE_MODEL_ID_PATTERN,
  PROFILE_PROVIDERS,
  PROFILE_ROLES,
  PROFILE_SCHEMA,
  canonicalProfileJson,
  findProfile,
  loadProfiles,
  profileProvenanceDigest,
  validateProfileDefinition,
} from '../mcp/v3/profile.mjs';
// Test-only cross-check: the shared authority lives behind this import so the
// production profile module never needs it.
import {
  ASSIGNMENT_ROLES,
  MODEL_ID_MAX,
  MODEL_ID_PATTERN,
  PROVIDERS,
  ROLE_ACCESS,
} from '../mcp/v3/run-manifest.mjs';
import { validateAssignmentManifestV1 } from '../mcp/v3/assignment-manifest.mjs';
import {
  BOUNDARY_ACCEPTED_MODELS,
  HOSTILE_MODEL_CORPUS,
  PARITY_ACCEPTED_MODELS,
  PROFILE_ROLE_FIXTURES,
  PROVIDER_MODEL_FIXTURES,
  assignmentExecutionFixture,
  profileDefinitionFixture,
  verifyAssignmentFixture,
} from './fixtures/r1-provider-model-fixtures.mjs';

const profileSource = (await readFile(new URL('../mcp/v3/profile.mjs', import.meta.url), 'utf8')).toString();

async function makeWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'r1-profile-contract-'));
  const repositoryPath = path.join(root, 'repo');
  const ownerConfigDir = path.join(root, 'owner-config');
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(ownerConfigDir, { recursive: true });
  const options = { repositoryPath, ownerConfigDir };
  const catalogPath = path.join(repositoryPath, '.codex', 'co-engineer-profiles.json');
  const writeCatalog = async (catalog) => {
    await mkdir(path.dirname(catalogPath), { recursive: true });
    await writeFile(catalogPath, JSON.stringify(catalog));
  };
  return { root, options, writeCatalog, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const expectCode = (code, label) => (error) => {
  if (error?.code !== code) return false;
  assert.ok(error.message.length > 0, `${label || code} must carry a message`);
  return true;
};

const modelDefinition = (provider, model) => profileDefinitionFixture({ provider, model });

test('profile vocabulary mirrors the shared run grammar without importing it', () => {
  // Providers: same exact routes, same content, independent freeze.
  assert.deepEqual([...PROFILE_PROVIDERS].sort(), [...PROVIDERS].sort());
  assert.notEqual(PROFILE_PROVIDERS, PROVIDERS, 'the mirror must be local, not a re-export');
  assert.equal(MAX_PROVIDER_PREFERENCE_ENTRIES, PROFILE_PROVIDERS.length);
  for (const provider of ['dsh', 'grok', 'cursor-local', 'cursor-cloud']) {
    assert.ok(PROVIDER_MODEL_FIXTURES.some((entry) => entry.provider === provider));
  }

  // Roles: exactly the shared vocabulary including read-only verify.
  assert.deepEqual([...PROFILE_ROLES].sort(), [...ASSIGNMENT_ROLES].sort());
  assert.deepEqual([...PROFILE_ROLES].sort(), [...PROFILE_ROLE_FIXTURES].sort());
  assert.ok(PROFILE_ROLES.includes('verify'));
  assert.equal(ROLE_ACCESS.verify, 'read_only');

  // Closed top-level schema: the exact field vocabulary ends with the
  // optional prerequisite flag.
  assert.deepEqual([...ALLOWED_PROFILE_FIELDS],
    ['schema', 'provider', 'model', 'role', 'expected_duration_ms', 'policy', 'default']);

  // Model grammar: identical pattern text and requested-byte bound.
  assert.equal(PROFILE_MODEL_ID_PATTERN.source, MODEL_ID_PATTERN.source);
  assert.equal(PROFILE_MODEL_ID_PATTERN.flags, MODEL_ID_PATTERN.flags);
  assert.equal(PROFILE_MODEL_ID_MAX_BYTES, MODEL_ID_MAX);
  assert.equal(PROFILE_MODEL_ID_MAX_BYTES, 128);

  // Import isolation: every static import of the production profile module is
  // a Node builtin or the neutral shared contract module - never a P02
  // run-manifest dependency.
  const specifiers = [...profileSource.matchAll(/^import\s[^'"]*?'([^']+)'/gmu)].map((m) => m[1]);
  assert.ok(specifiers.includes('./contract.mjs'), 'contract bounds remain imported');
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith('node:') || specifier === './contract.mjs',
      `unexpected production dependency: ${specifier}`,
    );
  }
  assert.ok(!specifiers.some((specifier) => specifier.includes('run-manifest')),
    'ProfileV1 must not import the run-manifest runtime');
});

test('PROFILE_DSH_MODELS stays deprecated informational data that never authorizes a model', () => {
  assert.ok(Object.isFrozen(PROFILE_DSH_MODELS));
  assert.deepEqual([...PROFILE_DSH_MODELS], ['muse-spark-1.2-contributor', 'stealth/ox-alpha']);
  const declaration = profileSource.indexOf('export const PROFILE_DSH_MODELS');
  assert.ok(declaration > 0, 'deprecated export must survive');
  const docblock = profileSource.lastIndexOf('/**', declaration);
  assert.ok(docblock !== -1 && /@deprecated/u.test(profileSource.slice(docblock, declaration)),
    'the export must carry its deprecation marker');

  // The identifier appears only inside its own docblock + declaration: no
  // validator consults it, so membership behavior cannot return silently.
  const elsewhere = profileSource.slice(0, docblock)
    + profileSource.slice(declaration + 'export const PROFILE_DSH_MODELS'.length);
  assert.ok(!elsewhere.includes('PROFILE_DSH_MODELS'), 'validation must never reference the deprecated list');
  assert.ok(!profileSource.includes('unknown_profile_model'),
    'the retired membership denial code must stay retired');
});

test('every exact provider accepts grammar-valid models with no membership enforcement', async () => {
  const { options, writeCatalog, cleanup } = await makeWorkspace();
  try {
    for (const { provider, models } of PROVIDER_MODEL_FIXTURES) {
      for (const model of models) {
        await writeCatalog({ probe: modelDefinition(provider, model) });
        const loaded = await loadProfiles(options);
        const definition = findProfile(loaded, 'probe').definition;
        assert.equal(definition.provider, provider);
        assert.equal(definition.model, model,
          `${provider} must accept ${model} regardless of any advertised list`);

        // Claim-neutrality: validated canonical output is exactly the
        // authored selection - no attestation, availability, or resolution
        // metadata is inferred or attached.
        assert.deepEqual({ ...definition }, modelDefinition(provider, model));
        assert.throws(
          () => validateProfileDefinition('probe', { ...modelDefinition(provider, model), attested_model: model }),
          expectCode('unknown_profile_field', 'attestation metadata stays unknown'),
        );
        assert.throws(
          () => validateProfileDefinition('probe', { ...modelDefinition(provider, model), resolved_provider: provider }),
          expectCode('unknown_profile_field', 'resolution metadata stays unknown'),
        );
      }
    }

    // DSH-specific non-enforcement: unlisted models behave identically to
    // listed ones beside provider "dsh".
    for (const model of ['future-dsh-model', 'unlisted-future/model.9']) {
      assert.ok(!PROFILE_DSH_MODELS.includes(model), 'fixture must be unadvertised');
      assert.doesNotThrow(() => validateProfileDefinition('probe', modelDefinition('dsh', model)));
    }
    for (const model of PROFILE_DSH_MODELS) {
      assert.doesNotThrow(() => validateProfileDefinition('probe', modelDefinition('dsh', model)));
    }

    // Grammar boundaries land exactly on the mirrored byte bound, and the
    // assignment side accepts the exact same boundary strings.
    for (const model of BOUNDARY_ACCEPTED_MODELS) {
      assert.ok(Buffer.byteLength(model, 'utf8') <= PROFILE_MODEL_ID_MAX_BYTES);
      for (const { provider } of PROVIDER_MODEL_FIXTURES) {
        assert.doesNotThrow(() => validateProfileDefinition('probe', modelDefinition(provider, model)));
        assert.doesNotThrow(
          () => validateAssignmentManifestV1(assignmentExecutionFixture(provider, model)),
          `assignment lanes must accept ${provider} at the same byte bound`,
        );
      }
    }

    // Shared opaque-identifier corpus: accepted IDENTICALLY by ProfileV1
    // (directly and end-to-end) and by AssignmentManifestV1 run and verify
    // lanes. Model identifiers are opaque - not paths, refs, commands, or
    // credentials - so hostile-looking shapes stay grammar-valid on both
    // sides with no profile-only or assignment-only extra clause.
    for (const { model } of PARITY_ACCEPTED_MODELS) {
      assert.ok(MODEL_ID_PATTERN.test(model), `${JSON.stringify(model)} must be grammar-valid`);
      assert.ok(Buffer.byteLength(model, 'utf8') <= MODEL_ID_MAX);
      for (const { provider } of PROVIDER_MODEL_FIXTURES) {
        assert.doesNotThrow(
          () => validateProfileDefinition('probe', modelDefinition(provider, model)),
          `ProfileV1 must accept ${provider}/${JSON.stringify(model)}`,
        );
        await writeCatalog({ probe: modelDefinition(provider, model) });
        const loaded = await loadProfiles(options);
        assert.equal(findProfile(loaded, 'probe').definition.model, model,
          `${provider} must load ${JSON.stringify(model)} end-to-end`);
        assert.doesNotThrow(
          () => validateAssignmentManifestV1(assignmentExecutionFixture(provider, model)),
          `run lanes must accept ${provider}/${JSON.stringify(model)}`,
        );
        assert.doesNotThrow(
          () => validateAssignmentManifestV1(verifyAssignmentFixture(provider, model)),
          `verify lanes must accept ${provider}/${JSON.stringify(model)}`,
        );
      }
    }
  } finally {
    await cleanup();
  }
});

test('the hostile model corpus fails typed and identically on both sides of the contract', async () => {
  const { options, writeCatalog, cleanup } = await makeWorkspace();
  try {
    const explains = {
      pattern: (model) => !MODEL_ID_PATTERN.test(model),
      // Documented for completeness and provably unfireable on its own: the
      // grammar's character class is ASCII-only, so every pattern-valid
      // identifier is at most 128 characters = at most 128 UTF-8 bytes. The
      // mirrored byte bound stays as defense in depth; its exact boundary is
      // exercised in BOUNDARY_ACCEPTED_MODELS.
      bytes: (model) => MODEL_ID_PATTERN.test(model)
        && Buffer.byteLength(model, 'utf8') > MODEL_ID_MAX,
    };
    for (const { provider } of PROVIDER_MODEL_FIXTURES) {
      for (const { model, impliedBy } of HOSTILE_MODEL_CORPUS) {
        // The documented predicate must genuinely explain the rejection under
        // the shared grammar alone, so profile grammar can never be stricter
        // or looser than assignment-execution grammar.
        assert.ok(explains[impliedBy](model),
          `${JSON.stringify(model)} rejection must be implied by ${impliedBy}`);

        assert.throws(
          () => validateProfileDefinition('probe', modelDefinition(provider, model)),
          expectCode('invalid_profile_model', 'direct validation'),
        );

        await writeCatalog({ probe: modelDefinition(provider, model) });
        await assert.rejects(() => loadProfiles(options),
          (error) => error.code === 'invalid_profile_model',
          `${provider} must reject ${JSON.stringify(model)} end-to-end`);

        const rejectLane = (run, label) => assert.throws(run, (error) => error.code === 'invalid_format'
          && error.path === 'assignments[0].execution.model', label);
        rejectLane(
          () => validateAssignmentManifestV1(assignmentExecutionFixture(provider, model)),
          `${provider} run lane must reject ${JSON.stringify(model)}`,
        );
        rejectLane(
          () => validateAssignmentManifestV1(verifyAssignmentFixture(provider, model)),
          `${provider} verify lane must reject ${JSON.stringify(model)}`,
        );
      }
    }
  } finally {
    await cleanup();
  }
});

test('assignment lanes and profiles accept and reject the exact same model corpus', () => {
  // Exact bidirectional parity: one shared grammar governs both sides, with no
  // profile-only or assignment-only extra clause, so the accepted fixture set
  // and the hostile corpus behave identically in both directions.
  for (const { provider, models } of PROVIDER_MODEL_FIXTURES) {
    for (const model of models) {
      assert.doesNotThrow(() => validateAssignmentManifestV1(assignmentExecutionFixture(provider, model)),
        `${provider}/${model} must execute as an explicit lane`);
      const verify = verifyAssignmentFixture(provider, model);
      assert.equal(verify.role, 'verify');
      assert.equal(verify.access, 'read_only');
      assert.doesNotThrow(() => validateAssignmentManifestV1(verify),
        `verify lanes must accept ${provider}/${model} read-only`);
    }
  }
  for (const { model } of PARITY_ACCEPTED_MODELS) {
    for (const { provider } of PROVIDER_MODEL_FIXTURES) {
      assert.doesNotThrow(
        () => validateAssignmentManifestV1(assignmentExecutionFixture(provider, model)),
        `${provider} must accept the shared opaque identifier ${JSON.stringify(model)}`,
      );
    }
  }
  for (const { model } of HOSTILE_MODEL_CORPUS) {
    for (const { provider } of PROVIDER_MODEL_FIXTURES) {
      const expectInvalidFormat = (run, label) => assert.throws(
        run,
        (error) => error.code === 'invalid_format'
          && error.path === 'assignments[0].execution.model',
        label,
      );
      expectInvalidFormat(
        () => validateAssignmentManifestV1(assignmentExecutionFixture(provider, model)),
        `${provider} execution must reject ${JSON.stringify(model)}`,
      );
      expectInvalidFormat(
        () => validateAssignmentManifestV1(verifyAssignmentFixture(provider, model)),
        `${provider} verify lane must reject ${JSON.stringify(model)}`,
      );
    }
  }
});

test('the top-level model identifier is exempt from semantic value scans; every other string stays scanned', () => {
  // Model identifiers are opaque: the exact top-level `model` value answers to
  // the shared grammar alone, so secret-, shell-, and ref-shaped identifiers
  // are accepted exactly as the assignment side accepts them.
  const opaqueCases = [
    'sk-abcdefghijklmnop',
    'ghp_' + 'a'.repeat(20),
    'cmd:model',
    'zsh/model',
    'refs/heads/model',
    'origin/model',
    'main',
  ];
  for (const model of opaqueCases) {
    assert.ok(MODEL_ID_PATTERN.test(model), `${model} must be grammar-valid for this exemption check`);
    for (const provider of ['dsh', 'cursor-cloud']) {
      assert.doesNotThrow(
        () => validateProfileDefinition('probe', modelDefinition(provider, model)),
        `${provider}/${model} is an opaque grammar-valid identifier`,
      );
    }
  }

  // The exemption is one exact field path, never a value shape: every other
  // string in the profile keeps failing closed with its dedicated code, and
  // the generic scans keep precedence over unknown-key rejection.
  const scannedCases = [
    [{ schema: PROFILE_SCHEMA, provider: 'dsh', role: 'review', note: 'sk-abcdefghijklmnop' },
      'profile_secret_value_rejected', 'unknown-key secret value'],
    [{ schema: PROFILE_SCHEMA, provider: 'dsh', role: 'review', note: '${DSH_MODEL}' },
      'profile_environment_value_rejected', 'unknown-key interpolation value'],
    [{ schema: PROFILE_SCHEMA, provider: 'dsh', role: 'review', note: 'a; rm -rf' },
      'profile_shell_value_rejected', 'unknown-key shell value'],
    [{ schema: PROFILE_SCHEMA, provider: 'dsh', role: 'review', note: 'refs/heads/main' },
      'profile_moving_ref_value_rejected', 'unknown-key moving-ref value'],
    // A non-string `model` container is not the exempt path: nested strings
    // under it are still scanned before the typed grammar failure.
    [{ schema: PROFILE_SCHEMA, provider: 'dsh', model: { nested: 'sk-abcdefghijklmnop' } },
      'profile_secret_value_rejected', 'nested value under a non-string model'],
    // The exemption is path-exact, never key-name-exact: a key literally
    // named `model` anywhere below the top level stays fully scanned.
    [{ schema: PROFILE_SCHEMA, provider: 'dsh', note: { model: 'sk-abcdefghijklmnop' } },
      'profile_secret_value_rejected', 'nested key named model under another field'],
  ];
  for (const [definition, code, label] of scannedCases) {
    assert.throws(() => validateProfileDefinition('probe', definition), expectCode(code, label));
  }
  assert.throws(
    () => validateProfileDefinition('probe', { schema: PROFILE_SCHEMA, provider: 'dsh', note: 'plain text' }),
    expectCode('unknown_profile_field', 'an unscanned unknown key still fails closed'),
  );
});

test('pairing and metadata errors keep their typed precedence', () => {
  // A model still requires an explicit known provider beside it: the
  // definition must LACK the provider key, not merely carry undefined.
  const orphanedModel = (({ provider: _omitted, ...rest }) => rest)(
    profileDefinitionFixture({ model: 'grok-4' }),
  );
  assert.throws(
    () => validateProfileDefinition('probe', orphanedModel),
    expectCode('invalid_profile_model_for_provider', 'missing provider'),
  );
  const unknownProviderModel = (({ model: _omitted, ...rest }) => rest)(
    profileDefinitionFixture({ provider: 'claude' }),
  );
  assert.throws(
    () => validateProfileDefinition('probe', { ...unknownProviderModel, model: 'claude-4' }),
    expectCode('unsupported_profile_provider', 'unknown provider beside a valid model'),
  );
  assert.throws(
    () => validateProfileDefinition('probe', {
      ...unknownProviderModel,
      model: 'has spaces',
      role: 'also-wrong',
      default: false,
    }),
    expectCode('unsupported_profile_provider', 'provider precedence beats every later field'),
  );

  const cases = [
    [profileDefinitionFixture({ provider: 'claude', model: 'claude-4' }), 'unsupported_profile_provider'],
    [profileDefinitionFixture({ provider: 'claude', model: '..' }), 'unsupported_profile_provider'],
    [profileDefinitionFixture({ provider: 'dsh', model: 'no spaces allowed', role: 'nope' }), 'invalid_profile_model'],
    [profileDefinitionFixture({ provider: 'dsh', role: 'nope', default: 'yes' }), 'unsupported_profile_role'],
    [profileDefinitionFixture({ provider: 'dsh', expected_duration_ms: 1, default: false }), 'invalid_profile_expected_duration_ms'],
    [profileDefinitionFixture({ provider: 'dsh', policy: { argv: [] }, default: 1 }), 'profile_executable_key_rejected'],
    [profileDefinitionFixture({ provider: 'dsh', default: null }), 'invalid_profile_default'],
  ];
  for (const [definition, code] of cases) {
    assert.throws(() => validateProfileDefinition('probe', definition), expectCode(code, JSON.stringify(definition)));
  }
});

test('digests and canonical goldens stay stable under the widened contract', () => {
  const flagged = Object.freeze({
    schema: PROFILE_SCHEMA,
    provider: 'cursor-cloud',
    model: 'claude-sonnet-4-5',
    role: 'verify',
    expected_duration_ms: 3_600_000,
    default: true,
  });

  const digest = profileProvenanceDigest({ name: 'golden-probe', definition: flagged });
  const reordered = profileProvenanceDigest({
    name: 'golden-probe',
    definition: {
      default: true,
      expected_duration_ms: 3_600_000,
      model: 'claude-sonnet-4-5',
      provider: 'cursor-cloud',
      role: 'verify',
      schema: PROFILE_SCHEMA,
    },
  });
  assert.equal(digest, reordered, 'key order must not change the digest');
  assert.equal(digest, profileProvenanceDigest({ name: 'golden-probe', definition: { ...flagged } }));

  assert.notEqual(digest, profileProvenanceDigest({
    name: 'golden-probe',
    definition: { ...flagged, model: 'claude-opus-4-6' },
  }), 'different models must not share a digest');
  const unflagged = profileProvenanceDigest({
    name: 'golden-probe',
    definition: (({ default: _omitted, ...rest }) => rest)(flagged),
  });
  assert.notEqual(digest, unflagged, 'the authored flag must bind into the digest');
  assert.notEqual(digest, profileProvenanceDigest({ name: 'other-probe', definition: flagged }));

  // Pinned canonical golden: sorted keys, exact flag binding.
  const canonical = canonicalProfileJson({ definition: flagged, name: 'golden-probe', schema: PROFILE_SCHEMA });
  assert.equal(canonical, '{"definition":{"default":true,"expected_duration_ms":3600000,'
    + '"model":"claude-sonnet-4-5","provider":"cursor-cloud","role":"verify",'
    + '"schema":"codex-co-engineer.profile.v1"},"name":"golden-probe",'
    + '"schema":"codex-co-engineer.profile.v1"}');
  assert.equal(digest, 'sha256:0555da0f2797f4ccc843792e4ee0e9721aa71f7b06f55ac0bbb18884423edb7d');
});

test('the widened surfaces observe exactly zero proxy traps', () => {
  let traps = 0;
  const counted = () => { traps += 1; return undefined; };
  const handler = {
    getPrototypeOf: counted, setPrototypeOf: counted, isExtensible: counted,
    preventExtensions: counted, getOwnPropertyDescriptor: counted, defineProperty: counted,
    has: counted, get: counted, set: counted, deleteProperty: counted,
    ownKeys: counted, apply: counted, construct: counted,
  };
  const hostile = new Proxy({ ...modelDefinition('dsh', 'stealth/ox-alpha'), default: true }, handler);

  for (const run of [
    () => validateProfileDefinition('hostile', hostile),
    () => canonicalProfileJson(hostile),
    () => profileProvenanceDigest({ name: 'hostile', definition: hostile }),
  ]) {
    const before = traps;
    assert.throws(run, expectCode('profile_proxy_rejected', 'live proxy'));
    assert.equal(traps, before, 'no handler trap may fire before typed rejection');
  }

  const revoked = Proxy.revocable(modelDefinition('grok', 'grok-4'), {});
  revoked.revoke();
  assert.throws(
    () => validateProfileDefinition('hostile', revoked.proxy),
    expectCode('profile_proxy_rejected', 'revoked proxy'),
  );
});

test('role verify and the default flag resolve end-to-end as ordinary data', async () => {
  const { options, writeCatalog, cleanup } = await makeWorkspace();
  try {
    await writeCatalog({
      'default': {
        schema: PROFILE_SCHEMA, provider: 'dsh', model: 'stealth/ox-alpha',
        role: 'verify', expected_duration_ms: 600_000, default: true,
      },
      'explicit-lane': {
        schema: PROFILE_SCHEMA, provider: 'cursor-cloud', model: 'claude-sonnet-4-5',
        role: 'review', expected_duration_ms: 600_000,
      },
    });
    const loaded = await loadProfiles(options);

    const namedDefault = findProfile(loaded, 'default');
    assert.equal(namedDefault.definition.role, 'verify');
    assert.equal(namedDefault.definition.default, true);
    assert.equal(findProfile(loaded, 'explicit-lane').definition.default, undefined);
    assert.equal(findProfile(loaded, 'nothing-here'), undefined,
      'neither the name nor the flag may resolve anything implicitly');

    const again = await loadProfiles(options);
    assert.equal(findProfile(again, 'default').digest, namedDefault.digest,
      'reload stability for the flagged record');
  } finally {
    await cleanup();
  }
});
