// AssignmentManifestV1 — deep per-assignment schema (ADR 0001 identifiers
// `deterministic_explicit_or_profile_resolution`, `profiles_data_only`,
// `manifests_carry_command_ids_not_argv`, `no_direct_mode_for_run_submissions`,
// `run_cloud_lane_requires_pinned_starting_ref`, `read_only_verification`).
//
// Additive v3 module. Validates one assignment object against the closed
// AssignmentManifestV1 vocabulary:
//   - role/access consistency (implement => writer; review|verify => read_only);
//   - bounded well-formed UTF-8 prompts;
//   - execution is exactly one explicit choice: a named profile reference
//     (data-only name, never an inline profile object) or an exact
//     provider + model pair from the 3.2.1 provider vocabulary — or it is
//     truly absent, which marks the lane selection_resolution_required for
//     P05 (root-profile fill) without relaxing any other field;
//   - explicit Cursor Cloud lanes must pin one exact 40-hex lowercase starting
//     SHA; local lanes must not carry one. Unresolved profile lanes may carry
//     the future pin, and P05 revalidates it after provider resolution;
//   - writer scopes are required non-empty relative globs; read-only lanes
//     must declare an empty scope;
//   - acceptance entries reference user-approved VerificationPolicyV1
//     command IDs with flat scalar parameters and bounded timeouts. Arbitrary
//     argv, executables, shells, and credentials are denied by the envelope's
//     forbidden-key classes before this schema runs;
//   - expected duration within the 3.2.1 deadline bounds and a closed,
//   duplicate-free required-evidence vocabulary.
//
// Validation is fail-fast in a fixed order so identical inputs always raise
// identical first errors.

import {
  ACCEPTANCE_ALLOWED_KEYS,
  ACCEPTANCE_MAX_COMMANDS,
  ASSIGNMENT_ALLOWED_KEYS,
  ASSIGNMENT_ID_PATTERN,
  COMMAND_ID_PATTERN,
  EVIDENCE_KINDS,
  MAX_TIMEOUT_MS,
  MIN_DURATION_MS,
  MIN_TIMEOUT_MS,
  PARAM_KEY_PATTERN,
  PARAM_VALUE_MAX_BYTES,
  PARAMS_MAX_KEYS,
  PROMPT_MAX_BYTES,
  PROMPT_MIN_BYTES,
  PROVIDERS,
  ROLE_ACCESS,
  RunContractV1Error,
  SHA40_PATTERN,
  assertAllowedKeys,
  assertBoundedText,
  assertDenseJsonArray,
  assertExpectedDurationMs,
  assertJsonDataObject,
  assertTimeoutMs,
  assertWriteScopePatterns,
  isPlainObject,
  utf8ByteLength,
  validateExecution,
} from './run-manifest.mjs';

function fail(code, path, message) {
  throw new RunContractV1Error(code, path, message);
}

export function validateResolvedStartingRefV1(assignment, provider, path = 'assignment') {
  if (!PROVIDERS.includes(provider)) {
    fail('unknown_provider', `${path}.execution.provider`, `${path}.execution.provider is not a supported provider.`);
  }
  const hasStartingRef = Object.hasOwn(assignment, 'starting_ref');
  if (hasStartingRef && provider !== 'cursor-cloud') {
    fail('starting_ref_forbidden_local', `${path}.starting_ref`,
      `${path}.starting_ref is only valid for cursor-cloud lanes; local lanes start at the run's immutable base_sha.`);
  }
  if (provider === 'cursor-cloud') {
    if (!hasStartingRef) {
      fail('cloud_starting_ref_required', `${path}.starting_ref`,
        `Every run cursor-cloud lane MUST pin one exact already-pushed provider-visible SHA in ${path}.starting_ref.`);
    }
    if (typeof assignment.starting_ref !== 'string' || !SHA40_PATTERN.test(assignment.starting_ref)) {
      fail('invalid_format', `${path}.starting_ref`,
        `${path}.starting_ref must be an exact 40-character lowercase hex commit SHA already visible to the provider.`);
    }
  }
}

function validateStartingRef(assignment, path, executionResolution) {
  if (executionResolution.kind === 'explicit') {
    validateResolvedStartingRefV1(assignment, executionResolution.provider, path);
    return;
  }
  // P02 validates the unresolved profile reference or the omitted execution,
  // while P05 deterministically resolves each selection_resolution_required
  // lane before dispatch and calls validateResolvedStartingRefV1. Such a lane
  // may carry the future Cloud pin now; if present, its format is already
  // immutable and exact.
  if (Object.hasOwn(assignment, 'starting_ref')
    && (typeof assignment.starting_ref !== 'string' || !SHA40_PATTERN.test(assignment.starting_ref))) {
    fail('invalid_format', `${path}.starting_ref`,
      `${path}.starting_ref must be an exact 40-character lowercase hex commit SHA.`);
  }
}

function validateParameters(parameters, path) {
  if (!isPlainObject(parameters)) {
    fail('invalid_type', path, `${path} must be a flat object of scalar parameters.`);
  }
  assertJsonDataObject(parameters, path);
  const keys = Object.keys(parameters).sort();
  if (keys.length > PARAMS_MAX_KEYS) {
    fail('out_of_range', path, `${path} exceeds ${PARAMS_MAX_KEYS} parameter keys.`);
  }
  for (const key of keys) {
    const entryPath = `${path}.${key}`;
    if (!PARAM_KEY_PATTERN.test(key)) {
      fail('invalid_format', entryPath, `${entryPath} violates the parameter-key grammar ${PARAM_KEY_PATTERN.source}.`);
    }
    const value = parameters[key];
    if (typeof value === 'string') {
      assertBoundedText(value, {
        min: 0, max: PARAM_VALUE_MAX_BYTES, path: entryPath, label: entryPath, allowBlank: true,
      });
    } else if (typeof value === 'number') {
      if (!Number.isInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        fail('invalid_type', entryPath, `${entryPath} numeric parameters must be safe integers.`);
      }
    } else if (typeof value !== 'boolean') {
      fail('invalid_type', entryPath, `${entryPath} parameters must be flat scalars (string, integer, boolean); no nested objects or arrays.`);
    }
  }
}

function validateAcceptance(acceptance, path) {
  assertDenseJsonArray(acceptance, path);
  if (acceptance.length > ACCEPTANCE_MAX_COMMANDS) {
    fail('out_of_range', path, `${path} exceeds ${ACCEPTANCE_MAX_COMMANDS} acceptance commands.`);
  }
  const seenCommandIds = new Set();
  for (let i = 0; i < acceptance.length; i += 1) {
    const entryPath = `${path}[${i}]`;
    const entry = acceptance[i];
    if (!isPlainObject(entry)) fail('invalid_type', entryPath, `${entryPath} must be an object.`);
    assertAllowedKeys(entry, ACCEPTANCE_ALLOWED_KEYS, entryPath);
    if (!Object.hasOwn(entry, 'command_id')) {
      fail('missing_key', `${entryPath}.command_id`, `${entryPath}.command_id is required.`);
    }
    if (typeof entry.command_id !== 'string' || !COMMAND_ID_PATTERN.test(entry.command_id)) {
      fail('invalid_format', `${entryPath}.command_id`,
        `${entryPath}.command_id must match ${COMMAND_ID_PATTERN.source}; manifests reference VerificationPolicyV1 commands by ID, never argv.`);
    }
    if (seenCommandIds.has(entry.command_id)) {
      fail('duplicate_command_id', `${entryPath}.command_id`, `${entryPath}.command_id "${entry.command_id}" repeats within this assignment.`);
    }
    seenCommandIds.add(entry.command_id);
    if (!Object.hasOwn(entry, 'timeout_ms')) {
      fail('missing_key', `${entryPath}.timeout_ms`, `${entryPath}.timeout_ms is required; acceptance timeouts have no hidden default.`);
    }
    assertTimeoutMs(entry.timeout_ms, `${entryPath}.timeout_ms`);
    if (Object.hasOwn(entry, 'parameters')) validateParameters(entry.parameters, `${entryPath}.parameters`);
  }
}

function validateRequiredEvidence(requiredEvidence, path) {
  assertDenseJsonArray(requiredEvidence, path);
  if (requiredEvidence.length === 0) {
    fail('out_of_range', path, `${path} needs at least one evidence kind.`);
  }
  const seen = new Set();
  for (let i = 0; i < requiredEvidence.length; i += 1) {
    const entryPath = `${path}[${i}]`;
    const kind = requiredEvidence[i];
    if (!EVIDENCE_KINDS.includes(kind)) {
      fail('unknown_evidence_kind', entryPath, `${entryPath} is not one of ${EVIDENCE_KINDS.join(', ')}.`);
    }
    if (seen.has(kind)) fail('duplicate_evidence_kind', entryPath, `${entryPath} repeats evidence kind "${kind}".`);
    seen.add(kind);
  }
}

// Validate one AssignmentManifestV1 object at `assignments[<index>]`.
// Throws RunContractV1Error on the first violation; returns undefined.
export function validateAssignmentManifestV1(assignment, index = 0) {
  const path = `assignments[${index}]`;
  if (!isPlainObject(assignment)) fail('invalid_type', path, `${path} must be an object.`);
  assertAllowedKeys(assignment, ASSIGNMENT_ALLOWED_KEYS, path);

  if (!Object.hasOwn(assignment, 'role')) fail('missing_key', `${path}.role`, `${path}.role is required.`);
  const role = assignment.role;
  if (!ROLE_ACCESS[role]) {
    fail('unknown_role', `${path}.role`, `${path}.role is not one of ${Object.keys(ROLE_ACCESS).join(', ')}.`);
  }
  if (!Object.hasOwn(assignment, 'access')) fail('missing_key', `${path}.access`, `${path}.access is required.`);
  const access = assignment.access;
  if (access !== 'writer' && access !== 'read_only') {
    fail('unknown_access', `${path}.access`, `${path}.access must be "writer" or "read_only".`);
  }
  if (ROLE_ACCESS[role] !== access) {
    fail('role_access_mismatch', `${path}.access`,
      `${path}: role "${role}" requires access "${ROLE_ACCESS[role]}", received "${access}".`);
  }

  if (!Object.hasOwn(assignment, 'prompt')) {
    fail('missing_key', `${path}.prompt`, `${path}.prompt is required; prompts have no hidden default.`);
  }
  assertBoundedText(assignment.prompt, {
    min: PROMPT_MIN_BYTES,
    max: PROMPT_MAX_BYTES,
    path: `${path}.prompt`,
    label: `${path}.prompt`,
  });
  // P02R1 reachability prerequisite: execution may be truly absent. The lane
  // then becomes selection_resolution_required for the P05 resolver (root
  // profile or explicit failure); nothing is guessed here. Every PRESENT
  // form keeps the exact prior contract, so null, {}, an own undefined, or a
  // partial pair still fails closed through validateExecution below.
  let executionResolution;
  if (!Object.hasOwn(assignment, 'execution')) {
    executionResolution = Object.freeze({ kind: 'omitted', provider: null });
  } else {
    executionResolution = validateExecution(assignment.execution, `${path}.execution`);
  }
  validateStartingRef(assignment, path, executionResolution);

  const scopePath = `${path}.write_scope`;
  if (!Object.hasOwn(assignment, 'write_scope')) {
    fail('missing_key', scopePath, `${scopePath} is required; read-only lanes declare [], writers declare their owned paths.`);
  }
  if (access === 'read_only') {
    if (Array.isArray(assignment.write_scope) && assignment.write_scope.length > 0) {
      fail('out_of_range', scopePath,
        `${scopePath} must be empty; read-only lanes never own writer paths.`);
    }
    assertWriteScopePatterns(assignment.write_scope, scopePath, { minPatterns: 0, maxPatterns: 0 });
  } else {
    assertWriteScopePatterns(assignment.write_scope, scopePath, { minPatterns: 1 });
  }

  if (!Object.hasOwn(assignment, 'acceptance')) {
    fail('missing_key', `${path}.acceptance`, `${path}.acceptance is required (use [] when a lane runs no approved commands).`);
  }
  validateAcceptance(assignment.acceptance, `${path}.acceptance`);

  if (!Object.hasOwn(assignment, 'expected_duration_ms')) {
    fail('missing_key', `${path}.expected_duration_ms`, `${path}.expected_duration_ms is required; deadlines have no hidden default.`);
  }
  assertExpectedDurationMs(assignment.expected_duration_ms, `${path}.expected_duration_ms`);

  if (!Object.hasOwn(assignment, 'required_evidence')) {
    fail('missing_key', `${path}.required_evidence`, `${path}.required_evidence is required; evidence obligations are explicit.`);
  }
  validateRequiredEvidence(assignment.required_evidence, `${path}.required_evidence`);
}
