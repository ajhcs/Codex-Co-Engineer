// Shared fixtures for the W3-P07 artifact-reference and path-policy tests.
// Pure data and tiny local helpers only; no I/O and no product imports
// beyond the two modules under test.

import {
  ARTIFACT_REF_SCHEMA_ID,
} from '../../mcp/v3/artifact-ref.mjs';

export const RUN_ID = 'run-artifact-01';
export const CHILD_A = 'lane-alpha';
export const CHILD_B = 'lane-beta';

const SHA_A = 'aa'.repeat(32);
const SHA_B = 'bb'.repeat(32);

export function validRef(overrides = {}) {
  return {
    schema: ARTIFACT_REF_SCHEMA_ID,
    run_id: RUN_ID,
    assignment_id: CHILD_A,
    artifact_kind: 'git_diff',
    artifact_class: 'sanitized',
    relative_path: `runs/${RUN_ID}/${CHILD_A}/diff.patch`,
    byte_length: 2048,
    sha256: SHA_A,
    media_type: 'text/plain',
    content_encoding: 'identity',
    ...overrides,
  };
}

export function secondRef(overrides = {}) {
  return validRef({
    assignment_id: CHILD_B,
    relative_path: `runs/${RUN_ID}/${CHILD_B}/diff.patch`,
    sha256: SHA_B,
    ...overrides,
  });
}

export function countingProxy(target) {
  const counts = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, has: 0, apply: 0 };
  const proxy = new Proxy(target, {
    get(inner, property, receiver) {
      counts.get += 1;
      return Reflect.get(inner, property, receiver);
    },
    ownKeys(inner) {
      counts.ownKeys += 1;
      return Reflect.ownKeys(inner);
    },
    getOwnPropertyDescriptor(inner, property, receiver) {
      counts.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(inner, property, receiver);
    },
    has(inner, property) {
      counts.has += 1;
      return Reflect.has(inner, property);
    },
    apply() {
      counts.apply += 1;
      throw new Error('proxy apply must never run');
    },
  });
  return { proxy, counts };
}

export function trapTotal(counts) {
  return counts.get + counts.ownKeys + counts.getOwnPropertyDescriptor + counts.has + counts.apply;
}
