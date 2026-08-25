// P26 run preflight — side-effect proofs. For every failure mode AND the
// success path, the observed world must come back byte-identical: the same
// files with the same bytes, the same refs, and nothing else. A failed
// preflight leaves no workspace, no branch or ref, no dispatch artifact,
// no lock file, no reservation — because the boundary never writes and its
// only spawns are read-only observations.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';

import { GIT_CLOSED_ENV } from '../mcp/v3/git-identity.mjs';
import {
  RUN_PREFLIGHT_READONLY_GIT_COMMANDS,
  validateRunPreflightV1,
} from '../mcp/v3/run-preflight.mjs';

const CLOSED_ENV_KEYS = Object.keys(GIT_CLOSED_ENV).sort();
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  createBareRepo,
  createLinearRepo,
  createSymlinkAliasRepo,
  createRecordingSpawn,
  hostFacts,
  laneManifestsForCount,
  runFixtureGitIn,
  twoLaneManifest,
  writerLane,
  preflightManifest,
} from './fixtures/r1-run-preflight-fixtures.mjs';

const SUFFICIENT_HOST = hostFacts();

async function snapshotState(root) {
  const entries = [];
  async function walk(relative) {
    const absolute = path.join(root, relative);
    const metadata = await lstat(absolute);
    if (metadata.isDirectory()) {
      entries.push({ p: relative, t: 'dir', m: metadata.mode });
      const children = await readdir(absolute);
      children.sort();
      for (const child of children) {
        await walk(path.join(relative, child));
      }
      return;
    }
    if (metadata.isSymbolicLink()) {
      entries.push({ p: relative, t: 'link', m: metadata.mode });
      return;
    }
    const digest = createHash('sha256');
    if (metadata.size <= 1024 * 1024) {
      digest.update(await readFile(absolute));
    } else {
      digest.update(String(metadata.size));
    }
    entries.push({ p: relative, t: 'file', m: metadata.mode, s: metadata.size, h: digest.digest('hex') });
  }
  await walk('');
  // refs/stash is included by for-each-ref, so no separate stash query.
  const refs = await runFixtureGitIn(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
  return { entries, refs };
}

function failureBattery(repo) {
  return [
    ['invalid envelope', twoLaneManifest({
      repositoryPath: repo.root,
      baseSha: repo.baseSha,
    }), (manifest) => { manifest.schema = 'not-the-run-schema'; }, 'invalid_format'],
    ['nine children exceed the maximum', laneManifestsForCount(9, {
      repositoryPath: repo.root,
      baseSha: repo.baseSha,
    }), null, 'preflight_child_count_exceeded'],
    ['overlapping writer scopes', preflightManifest([
      writerLane('lane-overlap-a', ['src/shared/**']),
      writerLane('lane-overlap-b', ['src/shared/nested/**']),
    ], { repositoryPath: repo.root, baseSha: repo.baseSha }), null, 'overlapping_writer_scope'],
    ['cpu capacity denial', twoLaneManifest({
      repositoryPath: repo.root,
      baseSha: repo.baseSha,
    }), null, 'host_cpu_capacity_exceeded', { host: hostFacts({ cpu_parallelism: 0 }) }],
    ['ram capacity denial', twoLaneManifest({
      repositoryPath: repo.root,
      baseSha: repo.baseSha,
    }), null, 'host_ram_capacity_exceeded',
    { host: hostFacts({ available_ram_bytes: 1 }) }],
    ['missing repository', twoLaneManifest({
      repositoryPath: '/definitely/not/present/repository',
      baseSha: repo.baseSha,
    }), null, 'repository_missing'],
    ['absent base commit', twoLaneManifest({
      repositoryPath: repo.root,
      baseSha: '0123456789abcdef0123456789abcdef01234567',
    }), null, 'base_identity_invalid'],
  ];
}

test('every failed preflight leaves the repository world byte-identical', async () => {
  const repo = await createLinearRepo();
  try {
    const before = await snapshotState(repo.root);
    const recording = createRecordingSpawn();
    for (const [label, manifest, mutate, expectedCode, optionsOverride] of failureBattery(repo)) {
      if (mutate) mutate(manifest);
      const options = { host: SUFFICIENT_HOST, spawn: recording.spawn, ...optionsOverride };
      let threw = false;
      try {
        await validateRunPreflightV1({ manifest }, options);
      } catch (error) {
        threw = true;
        assert.ok(error instanceof RunContractV1Error, `${label}: ${error}`);
        assert.equal(error.code, expectedCode, label);
      }
      assert.equal(threw, true, `${label} should have failed`);
      const after = await snapshotState(repo.root);
      assert.deepEqual(after, before, `world changed after: ${label}`);
    }
    // Only read-only observation commands ever ran across the whole battery.
    assert.ok(recording.records.length >= 2);
    for (const record of recording.records) {
      const commandIndex = record.args.indexOf('-C');
      assert.ok(commandIndex >= 0, record.args.join(' '));
      assert.ok(
        RUN_PREFLIGHT_READONLY_GIT_COMMANDS.includes(record.args[commandIndex + 2]),
        record.args.join(' '),
      );
      assert.deepEqual(record.envKeys, CLOSED_ENV_KEYS);
    }
  } finally {
    await repo.cleanup();
  }
});

const GIT_CLOSED_ENV_SORTED = {
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
  TZ: 'UTC',
  GIT_ASKPASS: '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_ALLOW_PROTOCOL: '',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  GIT_PROTOCOL_FROM_USER: '0',
  GIT_TERMINAL_PROMPT: '0',
};

test('a passing preflight launches nothing either', async () => {
  const repo = await createLinearRepo();
  try {
    const before = await snapshotState(repo.root);
    const recording = createRecordingSpawn();
    const receipt = await validateRunPreflightV1(
      { manifest: twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha }) },
      { host: SUFFICIENT_HOST, spawn: recording.spawn },
    );
    assert.equal(receipt.status, 'ready');
    for (const claim of Object.keys(receipt.side_effects)) {
      assert.equal(receipt.side_effects[claim], false);
    }
    const after = await snapshotState(repo.root);
    assert.deepEqual(after, before, 'world changed after a successful preflight');
  } finally {
    await repo.cleanup();
  }
});

test('failed preflights leave bare repositories and aliases untouched too', async () => {
  const bare = await createBareRepo();
  try {
    const before = await snapshotState(bare.root);
    const error = await validateRunPreflightV1({
      manifest: twoLaneManifest({
        repositoryPath: bare.root,
        baseSha: '0123456789abcdef0123456789abcdef01234567',
      }),
    }, { host: SUFFICIENT_HOST }).then(() => null).catch((caught) => caught);
    assert.ok(['repository_not_canonical'].includes(error.code), error.code);
    assert.deepEqual(await snapshotState(bare.root), before);
  } finally {
    await bare.cleanup();
  }

  const aliased = await createSymlinkAliasRepo();
  try {
    const before = await snapshotState(aliased.root);
    const error = await validateRunPreflightV1({
      manifest: twoLaneManifest({
        repositoryPath: `${aliased.root}-alias`,
        baseSha: aliased.baseSha,
      }),
    }, { host: SUFFICIENT_HOST }).then(() => null).catch((caught) => caught);
    assert.equal(error.code, 'repository_not_canonical');
    assert.deepEqual(await snapshotState(aliased.root), before);
  } finally {
    await aliased.cleanup();
  }
});
