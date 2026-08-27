// P26 run preflight — focused coverage of the launch-side validation gate:
// exact canonical repository/base identity, detached/canonical hostile
// inputs, composition with the accepted run contract, receipt freezing,
// and P03/P24-compatible GitIdentityV1 binding. Capacity and side-effect
// proofs live in their own suites.

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGitIdentityV1 } from '../mcp/v3/protected-identity.mjs';
import {
  PREFLIGHT_MAX_CHILDREN,
  PREFLIGHT_MIN_CHILDREN,
  PREFLIGHT_RAM_FLOOR_BYTES_PER_CHILD,
  RUN_PREFLIGHT_CHECKS,
  RUN_PREFLIGHT_ERROR_CODES,
  RUN_PREFLIGHT_SCHEMA_ID,
  RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS,
  describeRunPreflightV1,
  validateRunPreflightV1,
} from '../mcp/v3/run-preflight.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { validateGitIdentityV1 } from '../mcp/v3/protected-identity.mjs';
import {
  ASSIGNMENT_ID_A,
  ASSIGNMENT_ID_B,
  createBareRepo,
  createDetachedHeadRepo,
  createEmptyDirectory,
  createLinearRepo,
  createLinkedWorktreeRepo,
  createReplaceRefRepo,
  createSymlinkAliasRepo,
  createSymlinkedGitDirRepo,
  createTagObjectRepo,
  forgeGitDirFileRepo,
  hostFacts,
  laneManifestsForCount,
  preflightManifest,
  twoLaneManifest,
  writerLane,
} from './fixtures/r1-run-preflight-fixtures.mjs';

const SUFFICIENT_HOST = hostFacts();

async function preflightOk(manifest, options = {}) {
  return validateRunPreflightV1({ manifest }, { host: SUFFICIENT_HOST, ...options });
}

async function preflightError(manifest, options = {}) {
  try {
    await preflightOk(manifest, options);
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  throw new Error('expected the preflight to fail');
}

test('describeRunPreflightV1 is deterministic, frozen, and quotes owned bounds', () => {
  const first = describeRunPreflightV1();
  const second = describeRunPreflightV1();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  assert.equal(first.schema, RUN_PREFLIGHT_SCHEMA_ID);
  assert.equal(first.rule, 'validate_only_no_launch_side_effect');
  assert.equal(first.min_children, PREFLIGHT_MIN_CHILDREN);
  assert.equal(first.max_children, PREFLIGHT_MAX_CHILDREN);
  assert.equal(PREFLIGHT_MAX_CHILDREN, 8);
  assert.equal(PREFLIGHT_MIN_CHILDREN, 1);
  assert.equal(typeof PREFLIGHT_RAM_FLOOR_BYTES_PER_CHILD, 'number');
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(second));
});

test('a passing preflight returns a frozen ready receipt over observed repository facts', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    const receipt = await preflightOk(manifest);
    assert.equal(receipt.schema, RUN_PREFLIGHT_SCHEMA_ID);
    assert.equal(receipt.version, 1);
    assert.equal(receipt.status, 'ready');
    assert.equal(receipt.run_id, manifest.run_id);
    assert.deepEqual([...receipt.checks], [...RUN_PREFLIGHT_CHECKS]);
    assert.equal(receipt.children.count, 2);
    assert.equal(receipt.children.concurrency, manifest.policy.max_concurrency);
    assert.equal(receipt.repository.path, repo.root);
    assert.equal(receipt.repository.base_sha, repo.baseSha);
    assert.equal(receipt.repository.object_type, 'commit');
    assert.equal(receipt.repository.git_dir, `${repo.root}/.git`);
    for (const claim of RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS) {
      assert.equal(receipt.side_effects[claim], false);
    }
    assert.ok(Object.isFrozen(receipt));
    assert.ok(Object.isFrozen(receipt.children));
    assert.ok(Object.isFrozen(receipt.capacity));
    assert.ok(Object.isFrozen(receipt.repository));
    assert.ok(Object.isFrozen(receipt.side_effects));
  } finally {
    await repo.cleanup();
  }
});

test('the receipt binds a P03 GitIdentityV1 that P24 surfaces accept unchanged', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    const receipt = await preflightOk(manifest);
    const expected = buildGitIdentityV1({
      repository_path: repo.root,
      base_sha: repo.baseSha,
    });
    assert.equal(receipt.git_identity.digest, expected.digest);
    assert.equal(receipt.git_identity.schema, expected.schema);
    assert.equal(validateGitIdentityV1(receipt.git_identity).digest, expected.digest);
  } finally {
    await repo.cleanup();
  }
});

test('ambient host facts are read when none are injected', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = preflightManifest([writerLane(ASSIGNMENT_ID_A, ['src/alpha/**'])], {
      repositoryPath: repo.root,
      baseSha: repo.baseSha,
      policy: { max_concurrency: 1 },
    });
    const receipt = await validateRunPreflightV1({ manifest });
    assert.equal(receipt.capacity.source, 'ambient');
    assert.ok(Number.isSafeInteger(receipt.capacity.cpu_parallelism));
    assert.ok(Number.isSafeInteger(receipt.capacity.total_ram_bytes));
    assert.ok(Number.isSafeInteger(receipt.capacity.available_ram_bytes));
  } finally {
    await repo.cleanup();
  }
});

test('injected host facts are reported as injected', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    const receipt = await preflightOk(manifest, { host: hostFacts({ total_ram_bytes: 12_345_678_901 }) });
    assert.equal(receipt.capacity.source, 'injected');
    assert.equal(receipt.capacity.cpu_parallelism, 8);
    assert.equal(receipt.capacity.total_ram_bytes, 12_345_678_901);
  } finally {
    await repo.cleanup();
  }
});

test('the base SHA must exist as exactly one commit object', async () => {
  const repo = await createLinearRepo();
  try {
    const missing = '0123456789abcdef0123456789abcdef01234567';
    const error = await preflightError(
      twoLaneManifest({ repositoryPath: repo.root, baseSha: missing }),
    );
    assert.equal(error.code, 'base_identity_invalid');
    assert.equal(error.path, 'repository.base_sha');
  } finally {
    await repo.cleanup();
  }
});

test('tag, tree, and blob objects are denied as the immutable base', async () => {
  const repo = await createTagObjectRepo();
  try {
    for (const [label, sha] of [
      ['annotated tag object', repo.tagSha],
      ['tree object', repo.treeSha],
      ['blob object', repo.blobSha],
    ]) {
      const error = await preflightError(
        twoLaneManifest({ repositoryPath: repo.root, baseSha: sha }),
      );
      assert.equal(error.code, 'base_identity_invalid', label);
    }
  } finally {
    await repo.cleanup();
  }
});

test('symbolic or non-canonical base spellings never reach git', async () => {
  const repo = await createLinearRepo();
  try {
    const spellings = [
      'HEAD',
      '@',
      'main',
      'refs/heads/main',
      repo.baseSha.slice(0, 12),
      repo.baseSha.toUpperCase(),
      `${repo.baseSha}^{commit}`,
      `:${repo.baseSha}`,
      'g'.repeat(40),
      '0123456789ABCDEF0123456789abcdef01234567',
      'e'.repeat(64),
      '',
    ];
    let observedSpawns = 0;
    for (const spelling of spellings) {
      const error = await preflightError(
        twoLaneManifest({ repositoryPath: repo.root, baseSha: spelling }),
        { spawn: () => {
          observedSpawns += 1;
          throw new Error('no git observation may run for a hostile base spelling');
        } },
      );
      assert.equal(error.code, 'invalid_format', spelling);
      assert.match(error.message, /base_sha/u);
    }
    assert.equal(observedSpawns, 0);
  } finally {
    await repo.cleanup();
  }
});

test('a detached HEAD worktree still passes when the base is an exact commit', async () => {
  const repo = await createDetachedHeadRepo();
  try {
    const receipt = await preflightOk(
      twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha }),
    );
    assert.equal(receipt.status, 'ready');
    assert.equal(receipt.repository.object_type, 'commit');
  } finally {
    await repo.cleanup();
  }
});

test('a linked worktree root is a trusted layout for its own objects', async () => {
  const repo = await createLinkedWorktreeRepo();
  try {
    const linked = await import('node:fs/promises').then((fs) => fs.readFile(`${repo.worktreePath}/.git`, 'utf8'));
    assert.match(linked, /^gitdir: /u);
    const receipt = await preflightOk(
      twoLaneManifest({ repositoryPath: repo.worktreePath, baseSha: repo.headSha }),
    );
    assert.equal(receipt.status, 'ready');
    assert.notEqual(receipt.repository.git_dir, `${repo.worktreePath}/.git`);
  } finally {
    await repo.cleanup();
  }
});

test('untrusted .git layouts are rejected', async () => {
  const forged = await forgeGitDirFileRepo();
  try {
    const error = await preflightError(
      twoLaneManifest({ repositoryPath: forged.root, baseSha: forged.baseSha }),
    );
    assert.equal(error.code, 'repository_not_canonical');
  } finally {
    await forged.cleanup();
  }

  const symlinked = await createSymlinkedGitDirRepo();
  try {
    const error = await preflightError(
      twoLaneManifest({ repositoryPath: symlinked.root, baseSha: symlinked.baseSha }),
    );
    assert.equal(error.code, 'repository_layout_invalid');
  } finally {
    await symlinked.cleanup();
  }
});

test('symlink aliases of the canonical repository path are rejected', async () => {
  const repo = await createSymlinkAliasRepo();
  try {
    const error = await preflightError(
      twoLaneManifest({ repositoryPath: `${repo.root}-alias`, baseSha: repo.baseSha }),
    );
    assert.equal(error.code, 'repository_not_canonical');
    const canonical = await preflightOk(
      twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha }),
    );
    assert.equal(canonical.status, 'ready');
  } finally {
    await repo.cleanup();
  }
});

test('bare repositories and non-repository directories are rejected', async () => {
  const bare = await createBareRepo();
  try {
    const error = await preflightError(
      twoLaneManifest({ repositoryPath: bare.root, baseSha: '0123456789abcdef0123456789abcdef01234567' }),
    );
    assert.equal(error.code, 'repository_not_canonical');
  } finally {
    await bare.cleanup();
  }
  const empty = await createEmptyDirectory();
  try {
    const error = await preflightError(
      twoLaneManifest({ repositoryPath: empty.root, baseSha: '0123456789abcdef0123456789abcdef01234567' }),
    );
    assert.equal(error.code, 'repository_not_canonical');
  } finally {
    await empty.cleanup();
  }
});

test('missing repositories fail closed before any deeper observation', async () => {
  const error = await preflightError(twoLaneManifest({
    repositoryPath: '/definitely/not/present/repository',
    baseSha: '0123456789abcdef0123456789abcdef01234567',
  }));
  assert.equal(error.code, 'repository_missing');
});

test('replace refs shadowing object identity are denied', async () => {
  const repo = await createReplaceRefRepo();
  try {
    const error = await preflightError(
      twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha }),
    );
    assert.equal(error.code, 'replace_refs_denied');
  } finally {
    await repo.cleanup();
  }
});

test('an eight-lane run is inside the public bound and reports every child id', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = laneManifestsForCount(8, { repositoryPath: repo.root, baseSha: repo.baseSha });
    const receipt = await preflightOk(manifest);
    assert.equal(receipt.children.count, 8);
    assert.equal(receipt.children.assignment_ids.length, 8);
    assert.equal(new Set(receipt.children.assignment_ids).size, 8);
  } finally {
    await repo.cleanup();
  }
});

const KNOWN_UPSTREAM_CODES = new Set([
  'invalid_type', 'missing_key', 'unknown_key', 'invalid_format', 'out_of_range',
  'depth_exceeded', 'manifest_too_large', 'manifest_too_complex', 'invalid_array',
  'dependency_not_allowed', 'merge_authority_denied', 'executable_content_denied',
  'credential_content_denied', 'replay_or_fallback_denied', 'direct_mode_rejected',
  'overlapping_writer_scope', 'duplicate_scope_pattern', 'proxy_denied',
  'symbol_key_denied', 'aliased_reference_denied', 'non_enumerable_property_denied',
  'own_undefined_denied', 'invalid_json_value', 'invalid_json_type', 'value_depth_exceeded',
]);

test('preflight errors carry bounded content-free messages from a closed code set', async () => {
  const repo = await createLinearRepo();
  try {
    const failures = [
      twoLaneManifest({ repositoryPath: repo.root, baseSha: 'f'.repeat(40) }),
      twoLaneManifest({ repositoryPath: '/absent/repo', baseSha: repo.baseSha }),
      twoLaneManifest([{ assignment_id: 'x' }]),
    ];
    const seen = [];
    for (const manifest of failures) {
      try {
        await validateRunPreflightV1({ manifest }, { host: SUFFICIENT_HOST });
      } catch (error) {
        seen.push(error);
      }
    }
    const alias = await createSymlinkAliasRepo();
    try {
      try {
        await validateRunPreflightV1({
          manifest: twoLaneManifest({ repositoryPath: `${alias.root}-alias`, baseSha: alias.baseSha }),
        }, { host: SUFFICIENT_HOST });
      } catch (error) {
        seen.push(error);
      }
    } finally {
      await alias.cleanup();
    }
    for (const error of seen) {
      assert.ok(error instanceof RunContractV1Error);
      const owned = RUN_PREFLIGHT_ERROR_CODES.includes(error.code);
      assert.ok(owned || KNOWN_UPSTREAM_CODES.has(error.code),
        `code ${error.code} is outside the closed preflight vocabulary`);
      assert.ok(Buffer.byteLength(error.message, 'utf8') <= 200, error.message);
      assert.equal(/[\u0000-\u001f]/u.test(error.message), false, JSON.stringify(error.message));
    }
  } finally {
    await repo.cleanup();
  }
});

test('nine children exceed the public maximum with zero git spawns', async () => {
  const repo = await createLinearRepo();
  try {
    let spawned = false;
    const error = await preflightError(
      laneManifestsForCount(9, { repositoryPath: repo.root, baseSha: repo.baseSha }),
      { spawn: () => { spawned = true; throw new Error('no observation may run'); } },
    );
    assert.equal(error.code, 'preflight_child_count_exceeded');
    assert.equal(error.path, 'assignments');
    assert.equal(spawned, false);
    assert.doesNotMatch(error.message, /9/u);
  } finally {
    await repo.cleanup();
  }
});

test('an empty child set is below the public minimum', async () => {
  const repo = await createLinearRepo();
  try {
    const error = await preflightError(
      laneManifestsForCount(0, { repositoryPath: repo.root, baseSha: repo.baseSha }),
    );
    assert.equal(error.code, 'preflight_child_count_below_minimum');
    assert.equal(error.path, 'assignments');
  } finally {
    await repo.cleanup();
  }
});

test('absent or non-array child sets defer to the accepted upstream denials', async () => {
  const repo = await createLinearRepo();
  try {
    const missing = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    delete missing.assignments;
    const missingError = await preflightError(missing);
    assert.equal(missingError.code, 'missing_key');

    const foreign = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    foreign.assignments = { not: 'an array' };
    const typeError = await preflightError(foreign);
    assert.equal(typeError.code, 'invalid_type');
  } finally {
    await repo.cleanup();
  }
});

test('dependency edges keep their precise denial inside the composed pipeline', async () => {
  const repo = await createLinearRepo();
  try {
    const { writerLane, preflightManifest } = await import('./fixtures/r1-run-preflight-fixtures.mjs');
    const edged = writerLane(ASSIGNMENT_ID_A, ['src/alpha/**']);
    edged.depends_on = [ASSIGNMENT_ID_B];
    const manifest = preflightManifest([
      edged,
      writerLane(ASSIGNMENT_ID_B, ['src/beta/**']),
    ], { repositoryPath: repo.root, baseSha: repo.baseSha });
    const error = await preflightError(manifest);
    assert.ok(
      ['dependency_not_allowed', 'unknown_key', 'preflight_dependency_edge_denied'].includes(error.code),
      error.code,
    );
  } finally {
    await repo.cleanup();
  }
});

test('duplicate child ids keep their precise denial inside the composed pipeline', async () => {
  const repo = await createLinearRepo();
  try {
    const { writerLane, preflightManifest } = await import('./fixtures/r1-run-preflight-fixtures.mjs');
    const manifest = preflightManifest([
      writerLane(ASSIGNMENT_ID_A, ['src/alpha/**']),
      writerLane(ASSIGNMENT_ID_A, ['src/beta/**']),
    ], { repositoryPath: repo.root, baseSha: repo.baseSha });
    const error = await preflightError(manifest);
    assert.ok(
      ['duplicate_assignment_id', 'preflight_duplicate_child_id'].includes(error.code),
      error.code,
    );
  } finally {
    await repo.cleanup();
  }
});

test('the ready receipt proves the independent bounded fanout', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = laneManifestsForCount(3, { repositoryPath: repo.root, baseSha: repo.baseSha });
    const receipt = await preflightOk(manifest);
    assert.equal(receipt.children.independent, true);
    assert.deepEqual([...receipt.checks], [...RUN_PREFLIGHT_CHECKS]);
    assert.ok(RUN_PREFLIGHT_CHECKS.includes('child_bounds'));
    assert.ok(RUN_PREFLIGHT_CHECKS.includes('independent_fanout'));
  } finally {
    await repo.cleanup();
  }
});

test('duplicate writer scopes across lanes keep the accepted overlap denial', async () => {
  const repo = await createLinearRepo();
  try {
    const { writerLane, preflightManifest } = await import('./fixtures/r1-run-preflight-fixtures.mjs');
    const manifest = preflightManifest([
      writerLane(ASSIGNMENT_ID_A, ['src/shared/**']),
      writerLane(ASSIGNMENT_ID_B, ['src/shared/nested/**']),
    ], { repositoryPath: repo.root, baseSha: repo.baseSha });
    let spawned = false;
    const error = await preflightError(manifest, {
      spawn: () => { spawned = true; throw new Error('no observation may run'); },
    });
    assert.equal(error.code, 'overlapping_writer_scope');
    assert.equal(spawned, false);
  } finally {
    await repo.cleanup();
  }
});

test('CPU capacity denial fires before any git observation', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = laneManifestsForCount(8, {
      repositoryPath: repo.root,
      baseSha: repo.baseSha,
      policy: { max_concurrency: 8 },
    });
    let spawned = false;
    const error = await preflightError(manifest, {
      host: hostFacts({ cpu_parallelism: 7 }),
      spawn: () => { spawned = true; throw new Error('no observation may run'); },
    });
    assert.equal(error.code, 'host_cpu_capacity_exceeded');
    assert.equal(error.path, 'capacity');
    assert.equal(spawned, false);
    assert.doesNotMatch(error.message, /7|8/u);
  } finally {
    await repo.cleanup();
  }
});

test('RAM capacity denial honors the per-child floor at exact boundaries', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({
      repositoryPath: repo.root,
      baseSha: repo.baseSha,
      policy: { max_concurrency: 2 },
    });
    const oneByteShort = 2 * PREFLIGHT_RAM_FLOOR_BYTES_PER_CHILD - 1;
    const error = await preflightError(manifest, {
      host: hostFacts({ available_ram_bytes: oneByteShort, total_ram_bytes: oneByteShort + 4096 }),
    });
    assert.equal(error.code, 'host_ram_capacity_exceeded');
    assert.doesNotMatch(error.message, /536870911|536870912/u);

    const receipt = await preflightOk(manifest, {
      host: hostFacts({ available_ram_bytes: 2 * PREFLIGHT_RAM_FLOOR_BYTES_PER_CHILD }),
    });
    assert.equal(receipt.capacity.ram_ok, true);
    assert.equal(receipt.capacity.required_ram_bytes, 2 * PREFLIGHT_RAM_FLOOR_BYTES_PER_CHILD);
    assert.equal(receipt.capacity.cpu_ok, true);
  } finally {
    await repo.cleanup();
  }
});

test('single-lane runs need exactly one CPU slot and one RAM floor', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = preflightManifest([writerLane(ASSIGNMENT_ID_A, ['src/alpha/**'])], {
      repositoryPath: repo.root,
      baseSha: repo.baseSha,
      policy: { max_concurrency: 1 },
    });
    const receipt = await preflightOk(manifest, { host: hostFacts({ cpu_parallelism: 1 }) });
    assert.equal(receipt.capacity.source, 'injected');
    assert.equal(receipt.capacity.cpu_parallelism, 1);
    assert.equal(receipt.children.scope_pair_checks, 0);
  } finally {
    await repo.cleanup();
  }
});

test('the receipt counts every writer-scope pair the disjointness check compares', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = laneManifestsForCount(8, { repositoryPath: repo.root, baseSha: repo.baseSha });
    const receipt = await preflightOk(manifest);
    assert.equal(receipt.children.scope_pair_checks, 8 * 7 / 2);
  } finally {
    await repo.cleanup();
  }
});

test('duplicate writer scopes across lanes keep the accepted overlap denial', async () => {
  const repo = await createLinearRepo();
  try {
    const { writerLane, preflightManifest } = await import('./fixtures/r1-run-preflight-fixtures.mjs');
    const manifest = preflightManifest([
      writerLane(ASSIGNMENT_ID_A, ['src/shared/**']),
      writerLane(ASSIGNMENT_ID_B, ['src/shared/nested/**']),
    ], { repositoryPath: repo.root, baseSha: repo.baseSha });
    let spawned = false;
    const error = await preflightError(manifest, {
      spawn: () => { spawned = true; throw new Error('no observation may run'); },
    });
    assert.equal(error.code, 'overlapping_writer_scope');
    assert.equal(spawned, false);
  } finally {
    await repo.cleanup();
  }
});
