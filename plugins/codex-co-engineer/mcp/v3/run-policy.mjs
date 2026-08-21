// RunPolicyV1 — strict run-policy schema plus the complete-manifest
// composition entry point (ADR 0001 identifiers `disjoint_writer_scopes`,
// `immutable_repo_base_identity`, `no_post_dispatch_fallback_or_replay`,
// `codex_only_final_acceptance`, `attention_batch_v1`).
//
// Additive v3 module. RunPolicyV1 has NO hidden defaults: every one of the
// eight canonical policy keys is required on every submission, and the five
// safety literals are enforced as exact explicit values:
//   - require_same_base === true            (one immutable repo/base SHA)
//   - require_disjoint_writer_scopes === true
//   - allow_post_dispatch_fallback === false (no replay/fallback opt-in)
//   - allow_merge === false                  (Codex is the only integrator)
//   - allow_create_pr === false
// attention_mode and completion_mode use closed enums; max_concurrency is an
// integer within 1..8. Foreign keys keep the envelope's precise denial codes.
//
// validateCompleteRunManifestV1() composes this schema with the envelope
// (run-manifest.mjs) and the deep assignment schema (assignment-manifest.mjs)
// into the single public validation entry point for P02.

import {
  MAX_ASSIGNMENTS,
  MIN_ASSIGNMENTS,
  POLICY_ALLOWED_KEYS,
  POLICY_SCHEMA_ID,
  RunContractV1Error,
  assertAllowedKeys,
  isPlainObject,
  validateRunManifestV1,
} from './run-manifest.mjs';
import { validateAssignmentManifestV1 } from './assignment-manifest.mjs';

export const RUN_POLICY_SCHEMA_ID = POLICY_SCHEMA_ID;
export const ATTENTION_MODES = Object.freeze(['aggregate']);
export const COMPLETION_MODES = Object.freeze(['all_settled_then_verify']);
export const MAX_CONCURRENCY_LIMIT = MAX_ASSIGNMENTS;

function fail(code, path, message) {
  throw new RunContractV1Error(code, path, message);
}

function assertEnum(value, allowed, path, label) {
  if (!allowed.includes(value)) {
    fail('invalid_format', path, `${path} must be exactly one of ${allowed.map((v) => JSON.stringify(v)).join(', ')}; received ${JSON.stringify(value ?? null)}.`);
  }
}

// Validate one RunPolicyV1 object. Presence of every key is checked first (in
// canonical order), then values, so identical inputs always raise identical
// first errors.
export function validateRunPolicyV1(policy) {
  const path = 'policy';
  if (!isPlainObject(policy)) fail('invalid_type', path, 'policy must be a RunPolicyV1 object.');
  for (const key of POLICY_ALLOWED_KEYS) {
    if (!(key in policy)) {
      fail('missing_key', `${path}.${key}`, `${path}.${key} is required (${POLICY_SCHEMA_ID}); run policies have no hidden defaults.`);
    }
  }
  assertAllowedKeys(policy, POLICY_ALLOWED_KEYS, path);

  const literals = [
    ['require_same_base', true, 'policy_safety_literal'],
    ['require_disjoint_writer_scopes', true, 'policy_safety_literal'],
    ['allow_post_dispatch_fallback', false, 'replay_or_fallback_denied'],
    ['allow_merge', false, 'merge_authority_denied'],
    ['allow_create_pr', false, 'merge_authority_denied'],
  ];
  for (const [key, expected, violationCode] of literals) {
    if (policy[key] !== expected) {
      fail(violationCode, `${path}.${key}`,
        `${path}.${key} must be the explicit literal ${expected}; received ${JSON.stringify(policy[key])} (${violationCode}).`);
    }
  }

  const concurrency = policy.max_concurrency;
  if (typeof concurrency !== 'number' || !Number.isInteger(concurrency)
    || concurrency < MIN_ASSIGNMENTS || concurrency > MAX_CONCURRENCY_LIMIT) {
    fail('out_of_range', `${path}.max_concurrency`,
      `${path}.max_concurrency must be an integer between ${MIN_ASSIGNMENTS} and ${MAX_CONCURRENCY_LIMIT}; received ${JSON.stringify(concurrency ?? null)}.`);
  }
  assertEnum(policy.attention_mode, ATTENTION_MODES, `${path}.attention_mode`, 'attention_mode');
  assertEnum(policy.completion_mode, COMPLETION_MODES, `${path}.completion_mode`, 'completion_mode');
}

// Full P02 contract: envelope + deep AssignmentManifestV1 + RunPolicyV1.
// Returns the frozen envelope summary { run_id, assignment_count,
// assignment_ids }.
export function validateCompleteRunManifestV1(manifest) {
  return validateRunManifestV1(manifest, {
    validateAssignment: validateAssignmentManifestV1,
    validatePolicy: validateRunPolicyV1,
  });
}
