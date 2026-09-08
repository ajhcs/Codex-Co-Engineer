import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { assertRuntimeEntrypoints } from '../mcp/v3/runtime-entrypoints.mjs';

test('runtime preflight checks only the entrypoints needed by each provider path', async () => {
  const local = [];
  await assertRuntimeEntrypoints('grok', { inspectFile: async (file) => local.push(path.basename(file)) });
  assert.deepEqual(local.sort(), ['acp-worker.mjs', 'credential-handoff-loader.mjs']);

  const cloud = [];
  await assertRuntimeEntrypoints('cursor-cloud', { inspectFile: async (file) => cloud.push(path.basename(file)) });
  assert.deepEqual(cloud, ['cursor-cloud-worker.mjs']);
});

test('runtime preflight returns one bounded error for a missing installed artifact', async () => {
  await assert.rejects(
    assertRuntimeEntrypoints('cursor-local', {
      inspectFile: async (file) => {
        throw Object.assign(new Error(`missing ${file}?token=secret`), { code: 'ENOENT' });
      },
    }),
    (error) => {
      assert.equal(error.code, 'runtime_install_incomplete');
      assert.equal(error.message, 'The installed Codex-Co-Engineer runtime is incomplete.');
      assert.doesNotMatch(error.message, /token|credential-handoff-loader/iu);
      return true;
    },
  );
});
