// RunCombinedVerifierV1 — combined-candidate verification (P35; ADR 0001
// `gate_a_candidate_composition_and_combined_verification`,
// `diagnostic_partial_candidate_never_ready`, `codex_only_final_acceptance`).
//
// Additive v3 module. It verifies a run-owned candidate through accepted
// P13/P14/P15/P16/P28/P30/P32 evidence. It never repairs conflicts, never
// integrates, never mutates remotes or protected refs, and never claims
// Codex acceptance. Incomplete diagnostic output stays
// incomplete_candidate. Required missing, rejected, or unresolved writer
// lanes block ready_for_codex_review. composition.candidate_ref is
// revalidated through accepted P28 run-owned candidate-ref authority and
// same-run receipt identity, not a permissive string or regex check.
//
// This module does not import or own the server, supervisor, worker,
// provider, registry, runtime, scheduler, artifact-bridge, or composer
// implementation. Composition receipts are consumed as values. Optional
// P16 execution is injected; tests stub it.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  CONSTRAINED_VERIFICATION_SCHEMA_ID,
  CONSTRAINED_VERIFICATION_VERSION,
  executeConstrainedVerificationV1,
} from './constrained-verification-runner.mjs';
import {
  parseEvidenceDiscrepancyV1,
  parseVerifiedFactV1,
} from './evidence-bundle.mjs';
import {
  ACTOR_VALUES,
  CANDIDATE_REF_LEAF,
  CANDIDATE_REF_NAMESPACE,
  GIT_AUTHORITY_POLICY_V1,
  GIT_AUTHORITY_SCHEMA_ID,
  GIT_AUTHORITY_VERSION,
  bindAuthorityIdentityV1,
  classifyGitOperationV1,
  classifyRefV1,
  expectedCandidateRefV1,
  isRunOwnedCandidateRefV1,
  parseGitAuthorityPolicyV1,
  projectAuthorityEvidenceV1,
} from './git-authority.mjs';
import { verifyGitIdentityV1 } from './git-identity.mjs';
import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import { auditProtectedRefsV1 } from './protected-ref-audit.mjs';
import {
  projectRunApiBoundaryV1,
  RUN_API_BOUNDARY_SCHEMA_ID,
  RUN_API_BOUNDARY_VERSION,
} from './run-api-boundary.mjs';
import {
  RECEIPT_KEYS as COMPOSITION_RECEIPT_KEYS,
  RUN_CANDIDATE_COMPOSER_RECEIPT_SCHEMA_ID,
  RUN_CANDIDATE_COMPOSER_VERSION,
  COMPOSER_STATUSES,
  LANE_RESULT_KEYS,
} from './run-candidate-composer.mjs';
import {
  RunContractV1Error,
  assertBaseSha,
  assertRunId,
  isAssignmentId,
  isSha40,
} from './run-manifest.mjs';
import { verifyScopeV1 } from './scope-verifier.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  optOwn,
  ownDataValue,
} from './selection-json.mjs';

export const RUN_COMBINED_VERIFIER_SCHEMA_ID = 'codex-co-engineer.run-combined-verifier.v1';
export const RUN_COMBINED_VERIFIER_VERSION = 1;
export const RUN_COMBINED_VERIFIER_RECEIPT_SCHEMA_ID =
  'codex-co-engineer.run-combined-verifier-receipt.v1';

export const MAX_VERIFIER_OBJECT_KEYS = 48;
export const MAX_VERIFIER_KEY_BYTES = 128;

export const COMBINED_STATUSES = capturedFreeze([
  'blocked', 'failed', 'incomplete_candidate', 'verified',
]);
export const COMBINED_CHECKS = capturedFreeze([
  'request_quarantine',
  'composition_receipt',
  'p28_candidate_ref_authority',
  'p14_git_identity',
  'p15_scope',
  'p16_constrained_verification',
  'p30_protected_ref_audit',
  'p32_run_api_boundary',
  'one_parent_candidate',
  'remote_mutation_denied',
  'diagnostic_partial_never_ready',
  'codex_only_final_acceptance',
]);
export const COMBINED_SIDE_EFFECT_NONCLAIMS = capturedFreeze([
  'composer_imported',
  'default_branch_mutated',
  'head_mutated',
  'integrated',
  'merge_performed',
  'pr_created',
  'protected_ref_mutated',
  'push_performed',
  'rebase_performed',
  'release_created',
  'remote_mutated',
  'server_imported',
  'supervisor_imported',
  'tag_created',
]);

export const REQUEST_ALLOWED_KEYS = capturedFreeze([
  'composition', 'expected_base_ref', 'expected_protected_refs', 'identity',
  'orchestration', 'schema', 'verification', 'version',
]);
export const REQUEST_REQUIRED_KEYS = capturedFreeze([
  'composition', 'expected_base_ref', 'expected_protected_refs', 'identity',
  'orchestration', 'schema', 'version',
]);
export const IDENTITY_ALLOWED_KEYS = capturedFreeze([
  'assignment_id', 'base_sha', 'provider', 'repository_path', 'run_id',
]);
export const IDENTITY_REQUIRED_KEYS = capturedFreeze([
  'assignment_id', 'base_sha', 'repository_path', 'run_id',
]);
export const OPTIONS_ALLOWED_KEYS = capturedFreeze([
  'auditProtectedRefs', 'executeVerification', 'projectRunApiBoundary',
  'spawn', 'verifyGitIdentity', 'verifyScope',
]);
export const RECEIPT_KEYS = capturedFreeze([
  'api_boundary_status', 'assignment_id', 'base_sha', 'candidate_ref',
  'candidate_sha', 'checks', 'codex_only_final_acceptance', 'composition_status',
  'discrepancies', 'facts', 'incomplete', 'integrated', 'parent_count',
  'ready_for_codex_review', 'run_id', 'schema', 'side_effects', 'status',
  'verification_executed', 'version',
]);

export const RUN_COMBINED_VERIFIER_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'aliased_reference_denied', 'bounds_exceeded',
  'exotic_prototype_denied', 'identity_mismatch', 'invalid_format',
  'invalid_type', 'missing_key', 'non_enumerable_property_denied',
  'out_of_range', 'own_undefined_denied', 'proxy_denied',
  'remote_mutation_denied', 'symbol_key_denied', 'unknown_key',
  'unverified_identity', 'value_depth_exceeded',
]);

const DEFINE = Object.defineProperty;
const IS_PROXY = utilTypes.isProxy;
const OWN_KEYS = capturedOwnKeys;
const BYTE_LENGTH = NodeBuffer.byteLength.bind(NodeBuffer);
const HASH = createHash;
const HASH_DIGEST = Object.getPrototypeOf(HASH('sha256')).digest;
const HASH_UPDATE = Object.getPrototypeOf(HASH('sha256')).update;
const SET_CTOR = Set;
const BASE_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const MSG = capturedFreeze({
  accessor_property_denied: 'RunCombinedVerifierV1 denies accessor inputs.',
  aliased_reference_denied: 'RunCombinedVerifierV1 denies aliased inputs.',
  bounds_exceeded: 'RunCombinedVerifierV1 exceeded a closed verification bound.',
  exotic_prototype_denied: 'RunCombinedVerifierV1 denies exotic prototypes.',
  identity_mismatch: 'RunCombinedVerifierV1 rejected a mismatched run or base identity.',
  invalid_format: 'RunCombinedVerifierV1 rejected a value that violates a closed grammar.',
  invalid_type: 'RunCombinedVerifierV1 rejected a non-JSON verification value.',
  missing_key: 'RunCombinedVerifierV1 requires every canonical verification key.',
  non_enumerable_property_denied: 'RunCombinedVerifierV1 denies non-enumerable properties.',
  out_of_range: 'RunCombinedVerifierV1 rejected a value outside closed bounds.',
  own_undefined_denied: 'RunCombinedVerifierV1 denies own undefined values.',
  proxy_denied: 'RunCombinedVerifierV1 denies Proxy inputs.',
  remote_mutation_denied: 'RunCombinedVerifierV1 denies push and remote mutation.',
  symbol_key_denied: 'RunCombinedVerifierV1 denies symbol keys.',
  unknown_key: 'RunCombinedVerifierV1 rejects keys outside the closed vocabulary.',
  unverified_identity: 'RunCombinedVerifierV1 requires verified Git identity evidence.',
  value_depth_exceeded: 'RunCombinedVerifierV1 rejected nested input that exceeds closed depth.',
});

function deny(code, pathLabel) {
  fail(code, pathLabel, MSG[code] ?? MSG.invalid_format);
}

function publicCode(error) {
  if (error instanceof RunContractV1Error
    && capturedIncludes(RUN_COMBINED_VERIFIER_ERROR_CODES, error.code)) {
    return error.code;
  }
  return 'invalid_type';
}

function remap(error, pathLabel) {
  deny(publicCode(error), pathLabel);
}

function freezeRecord(keys, values) {
  const snapshot = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!Object.hasOwn(values, key)) continue;
    DEFINE(snapshot, key, {
      value: values[key], enumerable: true, writable: false, configurable: false,
    });
  }
  return capturedFreeze(snapshot);
}

function assertClosedObject(input, allowed, pathLabel) {
  if (input === undefined || input === null) deny('invalid_type', pathLabel);
  if (typeof input === 'object' || typeof input === 'function') {
    try { assertNotProxy(input, pathLabel); } catch (error) { remap(error, pathLabel); }
  }
  if (typeof input !== 'object') deny('invalid_type', pathLabel);
  try { assertPlainObject(input, 'invalid_type', pathLabel, pathLabel); } catch (error) {
    remap(error, pathLabel);
  }
  let keys;
  try { keys = OWN_KEYS(input); } catch { deny('invalid_type', pathLabel); }
  if (keys.length > MAX_VERIFIER_OBJECT_KEYS) deny('out_of_range', pathLabel);
  const allowedSet = new SET_CTOR(allowed);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key === 'symbol') deny('symbol_key_denied', pathLabel);
    if (typeof key !== 'string' || BYTE_LENGTH(key) > MAX_VERIFIER_KEY_BYTES) {
      deny('out_of_range', pathLabel);
    }
    if (!allowedSet.has(key)) deny('unknown_key', pathLabel);
  }
  try { assertDirectJsonClosure(input, pathLabel); } catch (error) { remap(error, pathLabel); }
  return input;
}

function requireKeys(input, keys, pathLabel) {
  for (let i = 0; i < keys.length; i += 1) {
    if (!hasOwn(input, keys[i])) deny('missing_key', pathLabel);
  }
}

function ownString(input, key, pathLabel) {
  const value = ownDataValue(input, key, pathLabel);
  if (typeof value !== 'string') deny('invalid_type', pathLabel);
  return value;
}

function digestOf(value) {
  const hash = HASH('sha256');
  HASH_UPDATE.call(hash, canonicalJsonStringify(value));
  return HASH_DIGEST.call(hash, 'hex');
}

function emptySideEffects() {
  const values = {};
  for (let i = 0; i < COMBINED_SIDE_EFFECT_NONCLAIMS.length; i += 1) {
    values[COMBINED_SIDE_EFFECT_NONCLAIMS[i]] = false;
  }
  return freezeRecord(COMBINED_SIDE_EFFECT_NONCLAIMS, values);
}

function parseIdentity(input, pathLabel) {
  const object = assertClosedObject(input, IDENTITY_ALLOWED_KEYS, pathLabel);
  requireKeys(object, IDENTITY_REQUIRED_KEYS, pathLabel);
  const runId = ownString(object, 'run_id', pathLabel);
  try { assertRunId(runId, pathLabel); } catch (error) { remap(error, pathLabel); }
  const baseSha = ownString(object, 'base_sha', pathLabel);
  try { assertBaseSha(baseSha, pathLabel); } catch (error) { remap(error, pathLabel); }
  const assignmentId = ownString(object, 'assignment_id', pathLabel);
  if (!isAssignmentId(assignmentId)) deny('invalid_format', pathLabel);
  const repositoryPath = ownString(object, 'repository_path', pathLabel);
  if (typeof repositoryPath !== 'string' || !repositoryPath.startsWith('/')) {
    deny('invalid_format', pathLabel);
  }
  const values = {
    run_id: runId, base_sha: baseSha, assignment_id: assignmentId, repository_path: repositoryPath,
  };
  if (hasOwn(object, 'provider')) values.provider = ownString(object, 'provider', pathLabel);
  return freezeRecord(IDENTITY_ALLOWED_KEYS, values);
}

function parseLaneResult(input, pathLabel) {
  const object = assertClosedObject(input, LANE_RESULT_KEYS, pathLabel);
  requireKeys(object, LANE_RESULT_KEYS, pathLabel);
  const assignmentId = ownString(object, 'assignment_id', pathLabel);
  if (!isAssignmentId(assignmentId)) deny('invalid_format', pathLabel);
  const applied = ownDataValue(object, 'applied', pathLabel);
  if (applied !== true && applied !== false) deny('invalid_type', pathLabel);
  const writeScope = ownDataValue(object, 'write_scope', pathLabel);
  if (!capturedIsArray(writeScope)) deny('invalid_type', pathLabel);
  const scope = [];
  for (let i = 0; i < writeScope.length; i += 1) {
    const pattern = ownDataValue(writeScope, String(i), pathLabel);
    if (typeof pattern !== 'string') deny('invalid_type', pathLabel);
    scope.push(pattern);
  }
  const headSha = ownDataValue(object, 'head_sha', pathLabel);
  if (headSha !== null && !isSha40(headSha)) deny('invalid_format', pathLabel);
  return freezeRecord(LANE_RESULT_KEYS, {
    assignment_id: assignmentId,
    kind: ownString(object, 'kind', pathLabel),
    state: ownString(object, 'state', pathLabel),
    applied,
    path_count: ownDataValue(object, 'path_count', pathLabel),
    head_sha: headSha,
    write_scope: capturedFreeze(scope),
  });
}

function parseComposition(input, identity, pathLabel) {
  const object = assertClosedObject(input, COMPOSITION_RECEIPT_KEYS, pathLabel);
  requireKeys(object, COMPOSITION_RECEIPT_KEYS, pathLabel);
  if (ownString(object, 'schema', pathLabel) !== RUN_CANDIDATE_COMPOSER_RECEIPT_SCHEMA_ID) {
    deny('invalid_format', pathLabel);
  }
  if (ownDataValue(object, 'version', pathLabel) !== RUN_CANDIDATE_COMPOSER_VERSION) {
    deny('invalid_format', pathLabel);
  }
  const status = ownString(object, 'status', pathLabel);
  if (!capturedIncludes(COMPOSER_STATUSES, status)) deny('invalid_format', pathLabel);
  const runId = ownString(object, 'run_id', pathLabel);
  const baseSha = ownString(object, 'base_sha', pathLabel);
  const assignmentId = ownString(object, 'assignment_id', pathLabel);
  if (runId !== identity.run_id || baseSha !== identity.base_sha
    || assignmentId !== identity.assignment_id) {
    deny('identity_mismatch', pathLabel);
  }
  const candidateSha = ownDataValue(object, 'candidate_sha', pathLabel);
  if (candidateSha !== null && !isSha40(candidateSha)) deny('invalid_format', pathLabel);
  const parentSha = ownDataValue(object, 'parent_sha', pathLabel);
  if (parentSha !== null && !isSha40(parentSha)) deny('invalid_format', pathLabel);
  const parentCount = ownDataValue(object, 'parent_count', pathLabel);
  const ready = ownDataValue(object, 'ready_for_codex_review', pathLabel);
  if (ready !== false) deny('invalid_format', pathLabel);
  const lanesValue = ownDataValue(object, 'lanes', pathLabel);
  if (!capturedIsArray(lanesValue)) deny('invalid_type', pathLabel);
  const lanes = [];
  for (let i = 0; i < lanesValue.length; i += 1) {
    lanes.push(parseLaneResult(ownDataValue(lanesValue, String(i), pathLabel), `${pathLabel}.lanes`));
  }
  return freezeRecord(capturedFreeze([
    'allow_diagnostic_partial_candidate', 'applied_assignment_ids', 'assignment_id',
    'base_sha', 'blocked_assignment_ids', 'candidate_ref', 'candidate_sha',
    'incomplete', 'lanes', 'parent_count', 'parent_sha', 'ready_for_codex_review',
    'run_id', 'schema', 'status', 'version',
  ]), {
    schema: RUN_CANDIDATE_COMPOSER_RECEIPT_SCHEMA_ID,
    version: RUN_CANDIDATE_COMPOSER_VERSION,
    status,
    run_id: runId,
    assignment_id: assignmentId,
    base_sha: baseSha,
    // Structural string only. Same-run P28 authority is revalidated in
    // verifyCombinedCandidateV1 before any Git inspection or ready claim.
    candidate_ref: ownString(object, 'candidate_ref', pathLabel),
    candidate_sha: candidateSha,
    parent_sha: parentSha,
    parent_count: parentCount,
    applied_assignment_ids: ownDataValue(object, 'applied_assignment_ids', pathLabel),
    blocked_assignment_ids: ownDataValue(object, 'blocked_assignment_ids', pathLabel),
    lanes: capturedFreeze(lanes),
    allow_diagnostic_partial_candidate: ownDataValue(
      object, 'allow_diagnostic_partial_candidate', pathLabel,
    ),
    incomplete: ownDataValue(object, 'incomplete', pathLabel) === true,
    ready_for_codex_review: false,
  });
}

function parseExpectedRefs(input, pathLabel) {
  try { assertNotProxy(input, pathLabel); } catch (error) { remap(error, pathLabel); }
  if (!capturedIsArray(input) || input.length < 1 || input.length > 16) deny('out_of_range', pathLabel);
  const refs = [];
  for (let i = 0; i < input.length; i += 1) {
    const entry = assertClosedObject(
      ownDataValue(input, String(i), pathLabel), ['ref', 'sha'], pathLabel,
    );
    requireKeys(entry, ['ref', 'sha'], pathLabel);
    const sha = ownString(entry, 'sha', pathLabel);
    if (!isSha40(sha)) deny('invalid_format', pathLabel);
    refs.push(freezeRecord(['ref', 'sha'], { ref: ownString(entry, 'ref', pathLabel), sha }));
  }
  return capturedFreeze(refs);
}

export function parseCombinedCandidateRequestV1(input) {
  const pathLabel = 'verify';
  const object = assertClosedObject(input, REQUEST_ALLOWED_KEYS, pathLabel);
  requireKeys(object, REQUEST_REQUIRED_KEYS, pathLabel);
  if (ownString(object, 'schema', pathLabel) !== RUN_COMBINED_VERIFIER_SCHEMA_ID) {
    deny('invalid_format', pathLabel);
  }
  if (ownDataValue(object, 'version', pathLabel) !== RUN_COMBINED_VERIFIER_VERSION) {
    deny('invalid_format', pathLabel);
  }
  const identity = parseIdentity(ownDataValue(object, 'identity', pathLabel), `${pathLabel}.identity`);
  const expectedBaseRef = ownString(object, 'expected_base_ref', pathLabel);
  if (!BASE_REF_PATTERN.test(expectedBaseRef)) deny('invalid_format', pathLabel);
  const composition = parseComposition(
    ownDataValue(object, 'composition', pathLabel), identity, `${pathLabel}.composition`,
  );
  const expectedProtectedRefs = parseExpectedRefs(
    ownDataValue(object, 'expected_protected_refs', pathLabel), `${pathLabel}.expected_protected_refs`,
  );
  const orchestration = ownDataValue(object, 'orchestration', pathLabel);
  try {
    assertNotProxy(orchestration, `${pathLabel}.orchestration`);
    assertPlainObject(orchestration, 'invalid_type', `${pathLabel}.orchestration`, `${pathLabel}.orchestration`);
  } catch (error) { remap(error, pathLabel); }
  let verification = null;
  if (hasOwn(object, 'verification')) {
    verification = ownDataValue(object, 'verification', pathLabel);
    try { assertNotProxy(verification, `${pathLabel}.verification`); } catch (error) {
      remap(error, pathLabel);
    }
  }
  return freezeRecord(REQUEST_ALLOWED_KEYS, {
    schema: RUN_COMBINED_VERIFIER_SCHEMA_ID,
    version: RUN_COMBINED_VERIFIER_VERSION,
    identity,
    expected_base_ref: expectedBaseRef,
    expected_protected_refs: expectedProtectedRefs,
    composition,
    orchestration,
    verification,
  });
}

function parseOptions(options, pathLabel = 'options') {
  if (options === undefined) {
    return freezeRecord(OPTIONS_ALLOWED_KEYS, {
      spawn: undefined,
      verifyGitIdentity: verifyGitIdentityV1,
      verifyScope: verifyScopeV1,
      auditProtectedRefs: auditProtectedRefsV1,
      executeVerification: executeConstrainedVerificationV1,
      projectRunApiBoundary: projectRunApiBoundaryV1,
    });
  }
  try { assertNotProxy(options, pathLabel); } catch (error) { remap(error, pathLabel); }
  try { assertPlainObject(options, 'invalid_type', pathLabel, pathLabel); } catch (error) {
    remap(error, pathLabel);
  }
  let keys;
  try { keys = OWN_KEYS(options); } catch { deny('invalid_type', pathLabel); }
  const allowedSet = new SET_CTOR(OPTIONS_ALLOWED_KEYS);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key === 'symbol') deny('symbol_key_denied', pathLabel);
    if (!allowedSet.has(key)) deny('unknown_key', pathLabel);
  }
  const resolve = (key, fallback) => {
    if (!hasOwn(options, key)) return fallback;
    const value = optOwn(options, key);
    if (key !== 'spawn' && (typeof value !== 'function' || IS_PROXY(value))) deny('invalid_type', pathLabel);
    if (key === 'spawn' && value !== undefined && (typeof value !== 'function' || IS_PROXY(value))) {
      deny('invalid_type', pathLabel);
    }
    return value;
  };
  return freezeRecord(OPTIONS_ALLOWED_KEYS, {
    spawn: resolve('spawn', undefined),
    verifyGitIdentity: resolve('verifyGitIdentity', verifyGitIdentityV1),
    verifyScope: resolve('verifyScope', verifyScopeV1),
    auditProtectedRefs: resolve('auditProtectedRefs', auditProtectedRefsV1),
    executeVerification: resolve('executeVerification', executeConstrainedVerificationV1),
    projectRunApiBoundary: resolve('projectRunApiBoundary', projectRunApiBoundaryV1),
  });
}

function appliedWriteScope(composition) {
  const patterns = [];
  const seen = new SET_CTOR();
  for (let i = 0; i < composition.lanes.length; i += 1) {
    const lane = composition.lanes[i];
    if (lane.applied !== true) continue;
    for (let j = 0; j < lane.write_scope.length; j += 1) {
      const pattern = lane.write_scope[j];
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      patterns.push(pattern);
    }
  }
  return patterns;
}

function identityRequestOf(request, headSha) {
  return {
    repository: {
      path: request.identity.repository_path,
      base_sha: request.identity.base_sha,
    },
    expected_base_ref: request.expected_base_ref,
    candidate_head_sha: headSha,
    run_id: request.identity.run_id,
    assignment_id: request.identity.assignment_id,
    sequence: 0,
  };
}

function spawnOptions(options) {
  return options.spawn === undefined ? undefined : { spawn: options.spawn };
}

function emitFact(request, status, payload, sequence) {
  return parseVerifiedFactV1({
    fact_id: 'git-identity',
    fact_kind: 'git_identity',
    status,
    code: 'host_observed',
    run_id: request.identity.run_id,
    assignment_id: request.identity.assignment_id,
    sequence,
    subject: 'combined-candidate',
    authority: 'platform_git',
    method: 'ancestry_check',
    input_digest: digestOf({
      run_id: request.identity.run_id, base_sha: request.identity.base_sha,
    }),
    output_digest: digestOf(payload),
    exit_code: status === 'verified' ? 0 : 1,
    duration_ms: 0,
    truncated: false,
    payload,
    artifact_digests: [],
  });
}

function emitDiscrepancy(id, request, factIds, sequence) {
  return parseEvidenceDiscrepancyV1({
    discrepancy_id: id,
    discrepancy_kind: 'security',
    status: 'recorded',
    code: 'security_boundary',
    run_id: request.identity.run_id,
    assignment_id: request.identity.assignment_id,
    sequence,
    claim_ids: [],
    fact_ids: factIds,
    artifact_digests: [],
  });
}

function authorityIdentityInput(request) {
  return {
    repository_path: request.identity.repository_path,
    base_sha: request.identity.base_sha,
    run_id: request.identity.run_id,
    assignment_id: request.identity.assignment_id,
  };
}

function revalidateCandidateRefAuthority(request) {
  const identityInput = authorityIdentityInput(request);
  let expected;
  let boundIdentity;
  try {
    parseGitAuthorityPolicyV1(GIT_AUTHORITY_POLICY_V1);
    boundIdentity = bindAuthorityIdentityV1(identityInput);
    expected = expectedCandidateRefV1({ run_id: boundIdentity.run_id });
  } catch {
    return { authorized: false, expected: null, evidence: null };
  }

  const candidateRef = request.composition.candidate_ref;
  const sameRunOwned = isRunOwnedCandidateRefV1(candidateRef, boundIdentity.run_id)
    && candidateRef === expected
    && candidateRef === `${CANDIDATE_REF_NAMESPACE}${boundIdentity.run_id}/${CANDIDATE_REF_LEAF}`
    && boundIdentity.run_id === request.identity.run_id
    && boundIdentity.run_id === request.composition.run_id
    && boundIdentity.assignment_id === request.identity.assignment_id
    && boundIdentity.assignment_id === request.composition.assignment_id
    && boundIdentity.base_sha === request.identity.base_sha
    && boundIdentity.base_sha === request.composition.base_sha;

  let classified;
  let verdict;
  let evidence;
  try {
    classified = classifyRefV1({ ref: candidateRef, identity: identityInput });
    verdict = classifyGitOperationV1({
      schema: GIT_AUTHORITY_SCHEMA_ID,
      version: GIT_AUTHORITY_VERSION,
      actor: ACTOR_VALUES[1],
      operation: 'compose_candidate_non_authoritative',
      identity: identityInput,
      ref: candidateRef,
      history: { parent_counts: [1] },
    });
    evidence = projectAuthorityEvidenceV1(verdict, {
      fact_id: 'git-identity',
      discrepancy_id: 'candidate-ref-authority',
      sequence: 0,
    });
  } catch {
    return { authorized: false, expected, evidence: null };
  }

  const classBound = classified.ref_class === 'platform_run_owned'
    && classified.code === 'protected_ref_write_denied'
    && classified.protected === true;
  const operationBound = verdict.verdict === 'allowed'
    && verdict.ref_class === 'platform_run_owned'
    && verdict.code === 'authority_ok'
    && verdict.run_id === boundIdentity.run_id
    && verdict.assignment_id === boundIdentity.assignment_id
    && verdict.base_sha === boundIdentity.base_sha;
  const fact = evidence.facts[0];
  const evidenceBound = fact !== undefined
    && evidence.facts.length === 1
    && fact.status === 'verified'
    && fact.run_id === boundIdentity.run_id
    && fact.assignment_id === boundIdentity.assignment_id
    && fact.payload.base_sha === boundIdentity.base_sha
    && evidence.discrepancies.length === 0;

  return {
    authorized: sameRunOwned === true
      && classBound === true
      && operationBound === true
      && evidenceBound === true,
    expected,
    evidence,
  };
}

function authorityFailureReceipt(request, payload, binding) {
  const evidence = binding.evidence;
  const denied = evidence !== null
    && evidence.facts.length > 0
    && evidence.facts[0].status === 'failed';
  let facts;
  let discrepancies;
  if (denied) {
    facts = [...evidence.facts];
    discrepancies = evidence.discrepancies.length > 0
      ? [...evidence.discrepancies]
      : [emitDiscrepancy('candidate-ref-authority', request, ['git-identity'], 1)];
  } else {
    facts = [emitFact(request, 'failed', payload, 0)];
    discrepancies = [emitDiscrepancy('candidate-ref-authority', request, ['git-identity'], 1)];
  }
  return finish(request, {
    status: 'failed',
    api_boundary_status: null,
    verification_executed: false,
    facts,
    discrepancies,
  });
}

function finish(request, values) {
  const incomplete = values.status === 'incomplete_candidate'
    || request.composition.incomplete === true
    || request.composition.status === 'incomplete_candidate';
  const ready = values.status === 'verified' && incomplete !== true;
  return freezeData(freezeRecord(RECEIPT_KEYS, {
    schema: RUN_COMBINED_VERIFIER_RECEIPT_SCHEMA_ID,
    version: RUN_COMBINED_VERIFIER_VERSION,
    status: values.status,
    run_id: request.identity.run_id,
    assignment_id: request.identity.assignment_id,
    base_sha: request.identity.base_sha,
    candidate_ref: expectedCandidateRefV1({ run_id: request.identity.run_id }),
    candidate_sha: request.composition.candidate_sha,
    parent_count: request.composition.parent_count,
    composition_status: request.composition.status,
    api_boundary_status: values.api_boundary_status,
    verification_executed: values.verification_executed === true,
    incomplete,
    ready_for_codex_review: ready,
    codex_only_final_acceptance: true,
    integrated: false,
    checks: COMBINED_CHECKS,
    side_effects: emptySideEffects(),
    facts: capturedFreeze(values.facts),
    discrepancies: capturedFreeze(values.discrepancies),
  }));
}

export async function verifyCombinedCandidateV1(input, options) {
  const request = parseCombinedCandidateRequestV1(input);
  const parsedOptions = parseOptions(options);
  const payload = {
    base_sha: request.identity.base_sha,
    head_sha: request.composition.candidate_sha ?? request.identity.base_sha,
  };
  const candidateRefAuthority = revalidateCandidateRefAuthority(request);
  if (candidateRefAuthority.authorized !== true) {
    return authorityFailureReceipt(request, payload, candidateRefAuthority);
  }

  if (request.composition.status === 'blocked'
    || request.composition.candidate_sha === null
    || request.composition.parent_count !== 1) {
    const status = request.composition.status === 'incomplete_candidate'
      ? 'incomplete_candidate' : 'blocked';
    return finish(request, {
      status,
      api_boundary_status: null,
      verification_executed: false,
      facts: [emitFact(request, 'failed', payload, 0)],
      discrepancies: [emitDiscrepancy('composition-blocked', request, ['git-identity'], 1)],
    });
  }

  const gitOptions = spawnOptions(parsedOptions);
  const identityInput = identityRequestOf(request, request.composition.candidate_sha);
  const identity = await parsedOptions.verifyGitIdentity(identityInput, gitOptions);
  if (identity.status !== 'verified') {
    return finish(request, {
      status: 'failed',
      api_boundary_status: null,
      verification_executed: false,
      facts: [emitFact(request, 'failed', payload, 0)],
      discrepancies: [emitDiscrepancy('git-identity', request, ['git-identity'], 1)],
    });
  }

  const writeScope = appliedWriteScope(request.composition);
  const scope = await parsedOptions.verifyScope({
    identity_request: identityInput,
    identity,
    access: 'writer',
    write_scope: writeScope,
    other_write_scopes: [],
  }, gitOptions);
  if (scope.status !== 'verified'
    || scope.observation.parent_count !== 1
    || scope.observation.new_commit_count !== 1) {
    return finish(request, {
      status: 'failed',
      api_boundary_status: null,
      verification_executed: false,
      facts: [...scope.facts],
      discrepancies: scope.discrepancies.length > 0
        ? [...scope.discrepancies]
        : [emitDiscrepancy('scope', request, ['git-diff'], 2)],
    });
  }

  const audit = await parsedOptions.auditProtectedRefs({
    schema: 'codex-co-engineer.protected-ref-audit.v1',
    version: 1,
    identity: {
      repository_path: request.identity.repository_path,
      base_sha: request.identity.base_sha,
      run_id: request.identity.run_id,
      assignment_id: request.identity.assignment_id,
    },
    expected_refs: request.expected_protected_refs.map((entry) => ({
      ref: entry.ref, sha: entry.sha,
    })),
  }, gitOptions);
  if (audit.status !== 'verified') {
    return finish(request, {
      status: 'failed',
      api_boundary_status: null,
      verification_executed: false,
      facts: [...audit.facts],
      discrepancies: [...audit.discrepancies],
    });
  }

  const apiIdentity = {
    run_id: request.identity.run_id,
    base_sha: request.identity.base_sha,
    assignment_id: request.identity.assignment_id,
  };
  if (capturedHasOwn(request.identity, 'provider')) apiIdentity.provider = request.identity.provider;
  const api = parsedOptions.projectRunApiBoundary({
    schema: RUN_API_BOUNDARY_SCHEMA_ID,
    version: RUN_API_BOUNDARY_VERSION,
    identity: apiIdentity,
    audit,
    orchestration: request.orchestration,
  });
  if (api.status !== 'ready') {
    return finish(request, {
      status: api.status === 'failed' ? 'failed' : 'blocked',
      api_boundary_status: api.status,
      verification_executed: false,
      facts: [...audit.facts],
      discrepancies: [emitDiscrepancy('api-boundary', request, ['git-identity'], 3)],
    });
  }

  let verificationExecuted = false;
  if (request.verification !== null) {
    const verification = await parsedOptions.executeVerification(request.verification);
    verificationExecuted = true;
    if (verification.schema !== CONSTRAINED_VERIFICATION_SCHEMA_ID
      || verification.version !== CONSTRAINED_VERIFICATION_VERSION
      || verification.outcome?.result !== 'pass'
      || verification.candidate_audit?.unchanged !== true) {
      return finish(request, {
        status: 'failed',
        api_boundary_status: api.status,
        verification_executed: true,
        facts: [...audit.facts],
        discrepancies: [emitDiscrepancy('verification', request, ['git-identity'], 4)],
      });
    }
  } else {
    return finish(request, {
      status: request.composition.status === 'incomplete_candidate'
        ? 'incomplete_candidate' : 'blocked',
      api_boundary_status: api.status,
      verification_executed: false,
      facts: [...identity.facts, ...scope.facts, ...audit.facts],
      discrepancies: request.composition.status === 'incomplete_candidate'
        ? [emitDiscrepancy('incomplete-candidate', request, ['git-identity'], 4)]
        : [emitDiscrepancy('verification-missing', request, ['git-identity'], 4)],
    });
  }

  const status = request.composition.status === 'incomplete_candidate'
    ? 'incomplete_candidate' : 'verified';
  return finish(request, {
    status,
    api_boundary_status: api.status,
    verification_executed: verificationExecuted,
    facts: [...identity.facts, ...scope.facts, ...audit.facts],
    discrepancies: status === 'incomplete_candidate'
      ? [emitDiscrepancy('incomplete-candidate', request, ['git-identity'], 4)]
      : [],
  });
}

export function describeRunCombinedVerifierV1() {
  return freezeData(capturedFreeze({
    schema: RUN_COMBINED_VERIFIER_SCHEMA_ID,
    version: RUN_COMBINED_VERIFIER_VERSION,
    receipt_schema: RUN_COMBINED_VERIFIER_RECEIPT_SCHEMA_ID,
    rule: 'verify_through_accepted_p13_p14_p15_p16_p30_p32_evidence',
    api: capturedFreeze([
      'describeRunCombinedVerifierV1', 'parseCombinedCandidateRequestV1',
      'verifyCombinedCandidateV1',
    ]),
    statuses: COMBINED_STATUSES,
    checks: COMBINED_CHECKS,
    error_codes: RUN_COMBINED_VERIFIER_ERROR_CODES,
    side_effect_nonclaims: COMBINED_SIDE_EFFECT_NONCLAIMS,
    ready_requires_complete_composition: true,
    incomplete_never_ready: true,
    codex_only_final_acceptance: true,
    integrated: false,
    remote_mutated: false,
    gate_a_claimed: false,
    imports_server: false,
    imports_supervisor: false,
    imports_runtime: false,
    imports_scheduler: false,
    imports_composer_functions: false,
    composed_surfaces: capturedFreeze({
      evidence_bundle: 'codex-co-engineer.evidence-bundle.v1',
      git_identity: 'codex-co-engineer.git-identity.v1',
      git_authority: GIT_AUTHORITY_SCHEMA_ID,
      scope_verifier: 'codex-co-engineer.scope-verifier.v1',
      constrained_verification: CONSTRAINED_VERIFICATION_SCHEMA_ID,
      protected_ref_audit: 'codex-co-engineer.protected-ref-audit.v1',
      run_api_boundary: RUN_API_BOUNDARY_SCHEMA_ID,
    }),
  }));
}

capturedFreeze(revalidateCandidateRefAuthority);
capturedFreeze(parseCombinedCandidateRequestV1);
capturedFreeze(verifyCombinedCandidateV1);
capturedFreeze(describeRunCombinedVerifierV1);
