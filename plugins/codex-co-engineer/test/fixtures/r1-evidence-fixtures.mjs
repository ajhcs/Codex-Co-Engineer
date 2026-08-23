// Shared fixtures for the W12-P13 EvidenceBundleV1 tests.
// Pure data and tiny local helpers; no I/O and no product imports beyond
// the evidence and artifact modules under test.

import { ARTIFACT_REF_SCHEMA_ID } from '../../mcp/v3/artifact-ref.mjs';
import { canonicalJsonStringify } from '../../mcp/v3/identity.mjs';
import { createHash } from 'node:crypto';

export const RUN_ID = 'run-evidence-01';
export const REQUEST_ID = 'sel-0123456789abcdef0123456789abcdef';
export const ASSIGNMENT_ID = 'lane-alpha';
export const PROVIDER = 'dsh';
export const MODEL = 'stealth/ox-alpha';
export const BASE_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
export const HEAD_SHA = 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0';
export const REPOSITORY_PATH = '/tmp/cce-r1-evidence-repo';
export const COMMAND_ID = 'unit-tests';

export const SHA_REPORT = '11'.repeat(32);
export const SHA_ACCEPT = '22'.repeat(32);
export const SHA_DIFF = '33'.repeat(32);
export const SHA_INPUT = '44'.repeat(32);
export const SHA_OUTPUT = '55'.repeat(32);
export const SHA_PATHSET = '66'.repeat(32);

export function payloadDigest(payload) {
  return createHash('sha256').update(canonicalJsonStringify(payload), 'utf8').digest('hex');
}

export function validClaim(overrides = {}) {
  const payload = overrides.payload ?? { result: 'pass' };
  const claim = {
    claim_id: 'c-tests',
    claim_kind: 'tests_passed',
    status: 'asserted',
    code: 'provider_reported',
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    sequence: 0,
    subject: 'unit-tests',
    payload,
    artifact_digests: [SHA_REPORT],
    ...overrides,
  };
  if (overrides.payload !== undefined) claim.payload = overrides.payload;
  return claim;
}

export function validModelClaim(overrides = {}) {
  return validClaim({
    claim_id: 'c-model',
    claim_kind: 'model_used',
    sequence: 1,
    subject: 'model',
    payload: { model: MODEL },
    ...overrides,
  });
}

export function validFact(overrides = {}) {
  const payload = overrides.payload ?? { command_id: COMMAND_ID, result: 'pass' };
  return {
    fact_id: 'f-accept',
    fact_kind: 'acceptance_results',
    status: 'verified',
    code: 'host_observed',
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    sequence: 0,
    subject: 'unit-tests',
    authority: 'platform_acceptance_runner',
    method: 'approved_command_execution',
    input_digest: SHA_INPUT,
    output_digest: SHA_OUTPUT,
    exit_code: 0,
    duration_ms: 1200,
    truncated: false,
    payload,
    artifact_digests: [SHA_ACCEPT],
    ...overrides,
  };
}

export function validGitIdentityFact(overrides = {}) {
  return validFact({
    fact_id: 'f-git',
    fact_kind: 'git_identity',
    sequence: 1,
    subject: 'repository',
    authority: 'platform_git',
    method: 'ancestry_check',
    exit_code: null,
    payload: { base_sha: BASE_SHA, head_sha: HEAD_SHA },
    artifact_digests: [SHA_DIFF],
    ...overrides,
  });
}

export function validArtifactRef(overrides = {}) {
  return {
    schema: ARTIFACT_REF_SCHEMA_ID,
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    artifact_kind: 'git_diff',
    artifact_class: 'sanitized',
    relative_path: `runs/${RUN_ID}/${ASSIGNMENT_ID}/diff.patch`,
    byte_length: 2048,
    sha256: SHA_DIFF,
    media_type: 'text/plain',
    content_encoding: 'identity',
    ...overrides,
  };
}

export function reportRef(overrides = {}) {
  return validArtifactRef({
    artifact_kind: 'provider_report',
    relative_path: `runs/${RUN_ID}/${ASSIGNMENT_ID}/report.txt`,
    sha256: SHA_REPORT,
    ...overrides,
  });
}

export function acceptanceRef(overrides = {}) {
  return validArtifactRef({
    artifact_kind: 'acceptance_output',
    relative_path: `runs/${RUN_ID}/${ASSIGNMENT_ID}/accept.json`,
    sha256: SHA_ACCEPT,
    media_type: 'application/json',
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
    getOwnPropertyDescriptor(inner, property) {
      counts.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(inner, property);
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
