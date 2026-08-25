// Neutral fixtures for RunOrchestrationV1 tests: disposable repositories,
// closed hostile environments, recording dispatchers, and side-effect
// snapshots. Tests own the assertions; nothing here ranks, defaults, or
// substitutes a provider.

import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

import { DENIED_OPERATIONS } from '../../mcp/v3/git-authority.mjs';
import { handoffPathFromProcessIdentity } from '../../mcp/v3/credential-boundary.mjs';
import {
  createLinearRepo,
  createRecordingSpawn,
  hostFacts,
  laneManifestsForCount,
  preflightManifest,
  runFixtureGitIn,
  twoLaneManifest,
  writerLane,
} from './r1-run-preflight-fixtures.mjs';
import { HOSTILE_ENV, withTempDir } from './r1-credential-boundary-fixtures.mjs';

export {
  createLinearRepo,
  createRecordingSpawn,
  hostFacts,
  laneManifestsForCount,
  preflightManifest,
  runFixtureGitIn,
  twoLaneManifest,
  writerLane,
  HOSTILE_ENV,
  withTempDir,
  DENIED_OPERATIONS,
};

export const RUN_ID = 'orchestration-under-test';
export const ASSIGNMENT_ID_A = 'lane-alpha';
export const ASSIGNMENT_ID_B = 'lane-beta';

export const SUFFICIENT_HOST = hostFacts();

export function orchestrationManifest(assignments, overrides = {}) {
  const manifest = preflightManifest(assignments, overrides);
  manifest.run_id = overrides.runId ?? RUN_ID;
  return manifest;
}

export function twoLaneOrchestrationManifest(overrides = {}) {
  return orchestrationManifest([
    writerLane(ASSIGNMENT_ID_A, ['src/alpha/**']),
    writerLane(ASSIGNMENT_ID_B, ['src/beta/**']),
  ], overrides);
}

export function mixedProviderManifest(overrides = {}) {
  const baseSha = overrides.baseSha ?? '0123456789abcdef0123456789abcdef01234567';
  return orchestrationManifest([
    writerLane('lane-grok', ['src/grok/**'], {
      execution: { provider: 'grok', model: 'grok-4' },
    }),
    writerLane('lane-local', ['src/local/**'], {
      execution: { provider: 'cursor-local', model: 'composer-1' },
    }),
    writerLane('lane-cloud', ['src/cloud/**'], {
      execution: { provider: 'cursor-cloud', model: 'claude-sonnet-4-5' },
      starting_ref: baseSha,
    }),
    writerLane('lane-muse', ['src/muse/**'], {
      execution: { provider: 'dsh', model: 'muse-spark-1.2-contributor' },
    }),
    writerLane('lane-ox', ['src/ox/**'], {
      execution: { provider: 'dsh', model: 'stealth/ox-alpha' },
    }),
  ], overrides);
}

export function createRecordingDispatcher({ failStopFor } = {}) {
  const calls = [];
  const stopped = [];
  const failStop = failStopFor == null
    ? null
    : new Set(Array.isArray(failStopFor) ? failStopFor : [failStopFor]);
  const dispatch = async (plan) => {
    calls.push({
      assignment_id: plan.assignment_id,
      provider: plan.provider,
      model: plan.model,
      identity: plan.identity,
      argv: [...plan.argv],
      envKeys: Object.keys(plan.env).sort(),
      env: plan.env,
    });
    return {
      identity: plan.identity,
      stop: async () => {
        stopped.push(plan.identity);
        if (failStop && failStop.has(plan.assignment_id)) {
          throw new Error('injected dispatcher stop failure');
        }
      },
    };
  };
  return { dispatch, calls, stopped };
}

export async function injectHandoffUnlinkFailure(identity) {
  const filePath = handoffPathFromProcessIdentity(identity);
  const directory = path.dirname(filePath);
  await unlink(filePath);
  await mkdir(filePath);
  return { filePath, directory };
}

export async function restoreInjectedHandoffUnlinkFailure(filePath) {
  await rm(filePath, { recursive: true, force: true });
}

export async function snapshotState(root) {
  const entries = [];
  async function walk(relative) {
    const absolute = path.join(root, relative);
    const metadata = await lstat(absolute);
    if (metadata.isDirectory()) {
      entries.push({ p: relative, t: 'dir', m: metadata.mode });
      const children = await readdir(absolute);
      children.sort();
      for (const child of children) await walk(path.join(relative, child));
      return;
    }
    if (metadata.isSymbolicLink()) {
      entries.push({ p: relative, t: 'link', m: metadata.mode });
      return;
    }
    const digest = createHash('sha256');
    if (metadata.size <= 1024 * 1024) digest.update(await readFile(absolute));
    else digest.update(String(metadata.size));
    entries.push({
      p: relative, t: 'file', m: metadata.mode, s: metadata.size, h: digest.digest('hex'),
    });
  }
  await walk('');
  const refs = await runFixtureGitIn(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
  return { entries, refs };
}

export function receiptContainsSecret(receipt, secrets) {
  const serialized = JSON.stringify(receipt);
  return secrets.some((secret) => typeof secret === 'string' && secret.length > 0 && serialized.includes(secret));
}

export { handoffPathFromProcessIdentity };
