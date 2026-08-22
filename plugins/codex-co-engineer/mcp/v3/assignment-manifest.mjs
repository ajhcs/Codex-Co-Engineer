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
// identical first errors. The public selection classifier reuses this same
// standalone surface (path prefix `assignment`) before returning a state;
// run-wide uniqueness and cross-lane writer-scope disjointness stay envelope
// validation.

import {
  capturedDescriptor,
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedJoin,
  isKnownAccess,
  isKnownProvider,
  isKnownRole,
  knownRolesJoined,
  requiredAccessForRole,
  sortedCapturedKeys,
} from './grammar.mjs';
import {
  ACCEPTANCE_ALLOWED_KEYS,
  ACCEPTANCE_MAX_COMMANDS,
  ASSIGNMENT_ALLOWED_KEYS,
  ASSIGNMENT_ID_PATTERN,
  COMMAND_ID_PATTERN,
  PARAM_KEY_PATTERN,
  EVIDENCE_KINDS,
  PARAM_VALUE_MAX_BYTES,
  PARAMS_MAX_KEYS,
  PROMPT_MAX_BYTES,
  PROMPT_MIN_BYTES,
  RunContractV1Error,
  assertAllowedKeys,
  assertBoundedText,
  assertDenseJsonArray,
  assertExpectedDurationMs,
  assertJsonDataObject,
  assertNoForbiddenKeysDeep,
  assertTimeoutMs,
  assertWriteScopePatterns,
  isAssignmentId,
  isCommandId,
  isParamKey,
  isPlainObject,
  isSha40,
  validateExecution,
} from './run-manifest.mjs';

function fail(code, path, message) {
  throw new RunContractV1Error(code, path, message);
}

export function validateResolvedStartingRefV1(assignment, provider, path = 'assignment') {
  if (!isKnownProvider(provider)) {
    fail('unknown_provider', `${path}.execution.provider`, `${path}.execution.provider is not a supported provider.`);
  }
  const hasStartingRef = capturedHasOwn(assignment, 'starting_ref');
  if (hasStartingRef && provider !== 'cursor-cloud') {
    fail('starting_ref_forbidden_local', `${path}.starting_ref`,
      `${path}.starting_ref is only valid for cursor-cloud lanes; local lanes start at the run's immutable base_sha.`);
  }
  if (provider === 'cursor-cloud') {
    if (!hasStartingRef) {
      fail('cloud_starting_ref_required', `${path}.starting_ref`,
        `Every run cursor-cloud lane MUST pin one exact already-pushed provider-visible SHA in ${path}.starting_ref.`);
    }
    const startingRef = capturedDescriptor(assignment, 'starting_ref').value;
    if (!isSha40(startingRef)) {
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
  if (capturedHasOwn(assignment, 'starting_ref')) {
    const startingRef = capturedDescriptor(assignment, 'starting_ref').value;
    if (!isSha40(startingRef)) {
      fail('invalid_format', `${path}.starting_ref`,
        `${path}.starting_ref must be an exact 40-character lowercase hex commit SHA.`);
    }
  }
}

function validateParameters(parameters, path) {
  if (!isPlainObject(parameters)) {
    fail('invalid_type', path, `${path} must be a flat object of scalar parameters.`);
  }
  assertJsonDataObject(parameters, path);
  const keys = sortedCapturedKeys(parameters);
  if (keys.length > PARAMS_MAX_KEYS) {
    fail('out_of_range', path, `${path} exceeds ${PARAMS_MAX_KEYS} parameter keys.`);
  }
  for (const key of keys) {
    const entryPath = `${path}.${key}`;
    if (!isParamKey(key)) {
      fail('invalid_format', entryPath, `${entryPath} violates the parameter-key grammar ${PARAM_KEY_PATTERN.source}.`);
    }
    const value = capturedDescriptor(parameters, key).value;
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
    const entry = capturedDescriptor(acceptance, String(i)).value;
    if (!isPlainObject(entry)) fail('invalid_type', entryPath, `${entryPath} must be an object.`);
    assertAllowedKeys(entry, ACCEPTANCE_ALLOWED_KEYS, entryPath);
    if (!capturedHasOwn(entry, 'command_id')) {
      fail('missing_key', `${entryPath}.command_id`, `${entryPath}.command_id is required.`);
    }
    const commandId = capturedDescriptor(entry, 'command_id').value;
    if (!isCommandId(commandId)) {
      fail('invalid_format', `${entryPath}.command_id`,
        `${entryPath}.command_id must match ${COMMAND_ID_PATTERN.source}; manifests reference VerificationPolicyV1 commands by ID, never argv.`);
    }
    if (seenCommandIds.has(commandId)) {
      fail('duplicate_command_id', `${entryPath}.command_id`, `${entryPath}.command_id "${commandId}" repeats within this assignment.`);
    }
    seenCommandIds.add(commandId);
    if (!capturedHasOwn(entry, 'timeout_ms')) {
      fail('missing_key', `${entryPath}.timeout_ms`, `${entryPath}.timeout_ms is required; acceptance timeouts have no hidden default.`);
    }
    assertTimeoutMs(capturedDescriptor(entry, 'timeout_ms').value, `${entryPath}.timeout_ms`);
    if (capturedHasOwn(entry, 'parameters')) {
      validateParameters(capturedDescriptor(entry, 'parameters').value, `${entryPath}.parameters`);
    }
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
    const kind = capturedDescriptor(requiredEvidence, String(i)).value;
    if (!capturedIncludes(EVIDENCE_KINDS, kind)) {
      fail('unknown_evidence_kind', entryPath, `${entryPath} is not one of ${capturedJoin(EVIDENCE_KINDS, ', ')}.`);
    }
    if (seen.has(kind)) fail('duplicate_evidence_kind', entryPath, `${entryPath} repeats evidence kind "${kind}".`);
    seen.add(kind);
  }
}

function validateAssignmentId(assignment, path) {
  const idPath = `${path}.assignment_id`;
  if (!capturedHasOwn(assignment, 'assignment_id')) {
    fail('missing_key', idPath, `${idPath} is required.`);
  }
  const assignmentId = capturedDescriptor(assignment, 'assignment_id').value;
  if (!isAssignmentId(assignmentId)) {
    fail('invalid_format', idPath, `assignment_id must match ${ASSIGNMENT_ID_PATTERN.source}`);
  }
}

function validateRoleAndAccess(assignment, path) {
  if (!capturedHasOwn(assignment, 'role')) fail('missing_key', `${path}.role`, `${path}.role is required.`);
  const role = capturedDescriptor(assignment, 'role').value;
  if (!isKnownRole(role)) {
    fail('unknown_role', `${path}.role`, `${path}.role is not one of ${knownRolesJoined()}.`);
  }
  if (!capturedHasOwn(assignment, 'access')) fail('missing_key', `${path}.access`, `${path}.access is required.`);
  const access = capturedDescriptor(assignment, 'access').value;
  if (!isKnownAccess(access)) {
    fail('unknown_access', `${path}.access`, `${path}.access must be "writer" or "read_only".`);
  }
  const requiredAccess = requiredAccessForRole(role);
  if (requiredAccess !== access) {
    fail('role_access_mismatch', `${path}.access`,
      `${path}: role "${role}" requires access "${requiredAccess}", received "${access}".`);
  }
  return access;
}

function validatePrompt(assignment, path) {
  if (!capturedHasOwn(assignment, 'prompt')) {
    fail('missing_key', `${path}.prompt`, `${path}.prompt is required; prompts have no hidden default.`);
  }
  assertBoundedText(capturedDescriptor(assignment, 'prompt').value, {
    min: PROMPT_MIN_BYTES,
    max: PROMPT_MAX_BYTES,
    path: `${path}.prompt`,
    label: `${path}.prompt`,
  });
}

function validateExecutionOrOmission(assignment, path) {
  // P02R1 reachability prerequisite: execution may be truly absent. The lane
  // then becomes selection_resolution_required for the P05 resolver (root
  // profile or explicit failure); nothing is guessed here. Every PRESENT
  // form keeps the exact prior contract, so null, {}, an own undefined, or a
  // partial pair still fails closed through validateExecution below.
  if (!capturedHasOwn(assignment, 'execution')) {
    return capturedFreeze({ kind: 'omitted', provider: null });
  }
  const execution = capturedDescriptor(assignment, 'execution').value;
  return validateExecution(execution, `${path}.execution`);
}

function validateWriteScope(assignment, path, access) {
  const scopePath = `${path}.write_scope`;
  if (!capturedHasOwn(assignment, 'write_scope')) {
    fail('missing_key', scopePath, `${scopePath} is required; read-only lanes declare [], writers declare their owned paths.`);
  }
  const writeScope = capturedDescriptor(assignment, 'write_scope').value;
  if (access === 'read_only') {
    if (capturedIsArray(writeScope) && writeScope.length > 0) {
      fail('out_of_range', scopePath,
        `${scopePath} must be empty; read-only lanes never own writer paths.`);
    }
    assertWriteScopePatterns(writeScope, scopePath, { minPatterns: 0, maxPatterns: 0 });
  } else {
    assertWriteScopePatterns(writeScope, scopePath, { minPatterns: 1 });
  }
}

function validateAcceptanceField(assignment, path) {
  if (!capturedHasOwn(assignment, 'acceptance')) {
    fail('missing_key', `${path}.acceptance`, `${path}.acceptance is required (use [] when a lane runs no approved commands).`);
  }
  validateAcceptance(capturedDescriptor(assignment, 'acceptance').value, `${path}.acceptance`);
}

function validateDuration(assignment, path) {
  if (!capturedHasOwn(assignment, 'expected_duration_ms')) {
    fail('missing_key', `${path}.expected_duration_ms`, `${path}.expected_duration_ms is required; deadlines have no hidden default.`);
  }
  assertExpectedDurationMs(
    capturedDescriptor(assignment, 'expected_duration_ms').value,
    `${path}.expected_duration_ms`,
  );
}

function validateEvidence(assignment, path) {
  if (!capturedHasOwn(assignment, 'required_evidence')) {
    fail('missing_key', `${path}.required_evidence`, `${path}.required_evidence is required; evidence obligations are explicit.`);
  }
  validateRequiredEvidence(
    capturedDescriptor(assignment, 'required_evidence').value,
    `${path}.required_evidence`,
  );
}

// Complete standalone AssignmentManifestV1 validation at `path`. Throws
// RunContractV1Error on the first violation; returns undefined. Does not
// enforce run-wide assignment-id uniqueness or cross-lane writer-scope
// disjointness — those remain envelope validation.
export function validateStandaloneAssignmentV1(assignment, path = 'assignment') {
  if (!isPlainObject(assignment)) fail('invalid_type', path, `${path} must be an object.`);
  assertAllowedKeys(assignment, ASSIGNMENT_ALLOWED_KEYS, path);
  assertNoForbiddenKeysDeep(assignment, path, 1);
  validateAssignmentId(assignment, path);
  const access = validateRoleAndAccess(assignment, path);
  validatePrompt(assignment, path);
  const executionResolution = validateExecutionOrOmission(assignment, path);
  validateStartingRef(assignment, path, executionResolution);
  validateWriteScope(assignment, path, access);
  validateAcceptanceField(assignment, path);
  validateDuration(assignment, path);
  validateEvidence(assignment, path);
}

// Validate one AssignmentManifestV1 object at `assignments[<index>]`.
// Throws RunContractV1Error on the first violation; returns undefined.
export function validateAssignmentManifestV1(assignment, index = 0) {
  validateStandaloneAssignmentV1(assignment, `assignments[${index}]`);
}

// Re-export so tests and later phases keep a single execution grammar.
export { validateExecution };
