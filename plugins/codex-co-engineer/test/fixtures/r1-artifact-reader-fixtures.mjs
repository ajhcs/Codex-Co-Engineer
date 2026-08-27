// Reader-only fixtures for the P10 bounded sanitized reader.
//
// Builds on P08-published sanitized artifacts. The only product imports
// are the accepted P07/P08 modules and the reader under test; nothing
// here imports or mocks P09 sanitizer internals.

import {
  makeStoreRoot,
  refFor,
  removeRoot,
  digestOf,
  RUN_ID,
  CHILD_A,
  CHILD_B,
} from './r1-artifact-store-fixtures.mjs';
import { countingProxy, validRef } from './r1-artifact-fixtures.mjs';
import { openArtifactStoreV1 } from '../../mcp/v3/artifact-store.mjs';

export {
  CHILD_A,
  CHILD_B,
  RUN_ID,
  countingProxy,
  digestOf,
  makeStoreRoot,
  refFor,
  removeRoot,
  validRef,
};

export function decodeSelected(page) {
  return Buffer.from(page.selected_content, 'base64');
}

export async function withStore(fn) {
  const root = makeStoreRoot('cce-p10-reader-');
  try {
    const store = await openArtifactStoreV1({ root });
    return await fn({ root, store });
  } finally {
    removeRoot(root);
  }
}

export async function withPublished(bytes, overrides, fn) {
  return withStore(async ({ root, store }) => {
    const ref = refFor(bytes, { artifact_class: 'sanitized', ...overrides });
    const receipt = await store.publish(ref, bytes);
    return fn({ root, store, ref, bytes, receipt });
  });
}

// A legal relative path long enough that a max-range page can exceed the
// reader wire cap and force reader-side clipping.
export function longRelativePath() {
  const segment = 'seg-' + 'n'.repeat(120);
  return `runs/${segment}/${segment}/${segment}/${segment}/${segment}/${segment}/wide.bin`;
}
