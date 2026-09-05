import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  READINESS_SNAPSHOT_FILE,
  loadReadinessSnapshot,
  saveReadinessSnapshot,
} from '../mcp/v3/readiness-snapshot.mjs';

test('readiness snapshots persist bounded content-free setup results', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-readiness-'));
  try {
    const observedAt = new Date().toISOString();
    const readiness = {
      grok: { installed: true, ready: false, reason: 'needs_login', probe_duration_ms: 21 },
      'cursor-local': { installed: false, ready: false, reason: 'not_installed', probe_duration_ms: 4 },
      dsh: {
        installed: true,
        ready: false,
        reason: 'credentials_missing',
        transport: 'acpx',
        model_options: {
          'meta/muse-spark-1.3-contributor': { ready: false },
          'stealth/ox-alpha': { ready: false },
        },
      },
      'cursor-cloud': { installed: true, ready: true, transport: 'cursor-sdk' },
    };
    await saveReadinessSnapshot(root, readiness, { observed_at: observedAt, probe_duration_ms: 28 });
    const raw = await readFile(path.join(root, READINESS_SNAPSHOT_FILE), 'utf8');
    assert.equal(raw.includes('MODEL_API_KEY'), false);
    assert.equal(raw.includes('CURSOR_API_KEY'), false);
    assert.equal(raw.includes('/home/'), false);
    const loaded = await loadReadinessSnapshot(root);
    assert.deepEqual(loaded, { observed_at: observedAt, readiness, probe_duration_ms: 28 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
