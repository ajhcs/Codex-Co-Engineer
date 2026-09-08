// FinalDecisionCardV1 — bounded PR-ready final decision card (ADR 0001
// `codex_only_final_acceptance`, `exact_identities`, `bounded_evidence`,
// `diagnostic_partial_candidate_never_ready`,
// `gate_a_no_protected_ref_mutation`).
//
// Additive v3 module. It projects already-typed candidate, worktree,
// verifier, test, CI, push, draft-PR, topology, lane, and protected-ref
// facts into one immutable machine-readable card. Readiness is computed
// only from those typed facts. exact_head/exact_tree bind independently
// observed identities on verifier, test, CI, push, and PR receipts;
// format-only SHAs and stale booleans never authorize a substituted
// head or tree. Provider prose, hidden/unknown checks, stale evidence,
// missing topology, missing verifier acceptance, a dirty worktree, an
// active git operation other than none, an unpublished head, a
// mismatched PR head, number-only or arbitrary HTTPS PR identity,
// protected-ref mutation, required lanes that are not explicitly
// accepted, and lane-scoped artifacts whose assignment_id is absent from
// the parsed attribution set never yield ready_for_sol_merge. Ghost or
// unknown assignments are never projected as trusted. The card does not
// infer a run-level external artifact class.
//
// The card cannot merge, push, rebase, create a PR, tag, or release.
// Codex remains the merge authority and may regular-merge only after
// exact-head, exact-tree, current-green-CI, and topology CAS checks plus
// the user's authorization. The card cannot grant merge or release
// authority. Progressive disclosure keeps
// a compact model-facing summary plus artifact references for expensive
// diff/log/evidence, with deterministic truncation provenance.
//
// This module does not import or own the server, supervisor, worker,
// provider, registry, runtime, scheduler, UI, or Git/network I/O.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  compareArtifactRefsV1,
  parseArtifactRefV1,
} from './artifact-ref.mjs';
import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
  capturedTest,
  capturedUtf8ByteLength,
  isKnownProvider,
  isKnownRole,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import {
  MAX_ASSIGNMENTS,
  MIN_ASSIGNMENTS,
  RunContractV1Error,
  assertBaseSha,
  assertDenseJsonArray,
  assertRunId,
  isAssignmentId,
  isSha40,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  fail,
  freezeData,
  hasOwn,
  ownDataValue,
} from './selection-json.mjs';

export const FINAL_DECISION_CARD_SCHEMA_ID = 'codex-co-engineer.final-decision-card.v1';
export const FINAL_DECISION_CARD_VERSION = 1;
export const FINAL_DECISION_CARD_RESULT_SCHEMA_ID =
  'codex-co-engineer.final-decision-card-result.v1';

export const PUBLIC_LABEL_READY = 'PR-ready';
export const PUBLIC_LABEL_BLOCKED = 'Blocked';
export const SOL_REGULAR_MERGE_ACTOR = 'sol_high_xhigh';

export const MAX_CARD_OBJECT_KEYS = 24;
export const MAX_CARD_KEY_BYTES = 128;
export const MAX_CARD_STRING_BYTES = 256;
export const MAX_PR_URL_BYTES = 256;
export const MAX_SUMMARY_BYTES = 512;
export const MAX_ARTIFACT_INPUT = 16;
export const MAX_ARTIFACT_RETAINED = 8;

export const PUBLIC_LABELS = capturedFreeze([PUBLIC_LABEL_READY, PUBLIC_LABEL_BLOCKED]);
export const CI_STATES = capturedFreeze([
  'green', 'hidden', 'pending', 'red', 'stale', 'unknown',
]);
export const CI_FRESHNESS = capturedFreeze(['current', 'stale']);
export const LANE_STATUSES = capturedFreeze([
  'blocked', 'cancelled', 'completed', 'dispatched', 'environment_blocked',
  'failed', 'needs_attention', 'running', 'timeout', 'transport_lost',
  'unknown', 'unresolved',
]);
export const ACCEPTED_LANE_STATUS = 'completed';
export const FAILED_LANE_STATUSES = capturedFreeze([
  'blocked', 'cancelled', 'environment_blocked', 'failed', 'timeout',
  'transport_lost',
]);
export const NONTERMINAL_LANE_STATUSES = capturedFreeze([
  'dispatched', 'needs_attention', 'running', 'unknown',
]);
export const VERIFIER_STATUSES = capturedFreeze([
  'blocked', 'failed', 'incomplete_candidate', 'verified',
]);
export const PUSH_STATES = capturedFreeze(['force', 'published-non-force', 'unpublished']);
export const WORKTREE_STATES = capturedFreeze(['clean', 'dirty']);
export const ACTIVE_GIT_OPERATIONS = capturedFreeze([
  'bisect', 'cherry-pick', 'merge', 'none', 'rebase', 'revert', 'sequencer',
  'unknown',
]);
export const PR_STATES = capturedFreeze(['closed', 'merged', 'open']);
export const PR_PROVIDERS = capturedFreeze(['github']);
export const PR_HOSTS = capturedFreeze(['github.com']);
export const ACCEPTED_PR_STATE = 'open';
export const ACCEPTED_GIT_OPERATION = 'none';
export const ARTIFACT_TRUNCATION_REASON = 'artifact_bound';
export const SOL_CAS_CHECKS = capturedFreeze([
  'exact_head', 'exact_tree', 'current_green_ci', 'topology',
]);
export const CARD_CHECKS = capturedFreeze([
  'request_quarantine',
  'exact_candidate_identity',
  'worktree_clean',
  'no_active_git_operation',
  'verifier_acceptance',
  'test_evidence',
  'ci_current_green',
  'non_force_push',
  'draft_pr_identity',
  'pr_head_match',
  'topology_cas',
  'protected_ref_unmutated',
  'lanes_resolved',
  'required_lanes_accepted',
  'artifact_assignment_bound',
  'no_provider_prose',
  'card_cannot_merge',
]);
export const BLOCKER_CODES = capturedFreeze([
  'active_git_operation',
  'candidate_not_composed',
  'ci_not_green',
  'dirty_worktree',
  'force_push',
  'hidden_checks',
  'mismatched_pr_head',
  'missing_candidate_branch',
  'missing_candidate_head',
  'missing_candidate_tree',
  'missing_draft_pr',
  'missing_target_branch',
  'missing_topology',
  'missing_verifier_acceptance',
  'partial_provider_failure',
  'protected_ref_mutation',
  'stale_ci',
  'stale_evidence',
  'tests_not_passed',
  'unknown_assignment',
  'unknown_checks',
  'unpublished_head',
  'unresolved_lanes',
]);
export const MAX_BLOCKERS = BLOCKER_CODES.length;
export const CARD_SIDE_EFFECT_NONCLAIMS = capturedFreeze([
  'create_pr',
  'force_push',
  'git_invoked',
  'merge',
  'network_invoked',
  'protected_ref_mutated',
  'provider_invoked',
  'push',
  'rebase',
  'release',
  'remote_mutated',
  'tag',
]);

export const INPUT_ALLOWED_KEYS = capturedFreeze([
  'artifacts', 'candidate', 'ci', 'identity', 'lanes', 'pr', 'protected_ref',
  'push', 'schema', 'tests', 'topology', 'verifier', 'version', 'worktree',
]);
export const INPUT_REQUIRED_KEYS = capturedFreeze([
  'candidate', 'ci', 'identity', 'lanes', 'pr', 'protected_ref', 'push',
  'schema', 'tests', 'topology', 'verifier', 'version', 'worktree',
]);
export const IDENTITY_ALLOWED_KEYS = capturedFreeze(['base_sha', 'run_id']);
export const IDENTITY_REQUIRED_KEYS = IDENTITY_ALLOWED_KEYS;
export const CANDIDATE_ALLOWED_KEYS = capturedFreeze([
  'branch', 'composed', 'head', 'tree',
]);
export const CANDIDATE_REQUIRED_KEYS = CANDIDATE_ALLOWED_KEYS;
export const WORKTREE_ALLOWED_KEYS = capturedFreeze(['active_git_operation', 'clean']);
export const WORKTREE_REQUIRED_KEYS = WORKTREE_ALLOWED_KEYS;
export const OBSERVED_IDENTITY_KEYS = capturedFreeze([
  'freshness', 'observed_head', 'observed_tree',
]);
export const VERIFIER_ALLOWED_KEYS = capturedFreeze([
  'accepted', 'freshness', 'observed_head', 'observed_tree', 'status',
]);
export const VERIFIER_REQUIRED_KEYS = VERIFIER_ALLOWED_KEYS;
export const TESTS_ALLOWED_KEYS = capturedFreeze([
  'freshness', 'observed_head', 'observed_tree', 'passed', 'present',
]);
export const TESTS_REQUIRED_KEYS = TESTS_ALLOWED_KEYS;
export const CI_ALLOWED_KEYS = capturedFreeze([
  'freshness', 'hidden_checks', 'observed_head', 'observed_tree', 'state',
  'unknown_checks',
]);
export const CI_REQUIRED_KEYS = CI_ALLOWED_KEYS;
export const PUSH_ALLOWED_KEYS = capturedFreeze([
  'force', 'freshness', 'observed_head', 'observed_tree', 'published',
]);
export const PUSH_REQUIRED_KEYS = PUSH_ALLOWED_KEYS;
export const PR_ALLOWED_KEYS = capturedFreeze([
  'freshness', 'head', 'host', 'is_draft', 'number', 'owner', 'provider',
  'repo', 'state', 'target_branch', 'tree',
]);
export const PR_REQUIRED_KEYS = PR_ALLOWED_KEYS;
export const PR_RESULT_KEYS = capturedFreeze([...PR_ALLOWED_KEYS, 'url']);
export const TOPOLOGY_ALLOWED_KEYS = capturedFreeze(['digest', 'expected_digest']);
export const TOPOLOGY_REQUIRED_KEYS = TOPOLOGY_ALLOWED_KEYS;
export const PROTECTED_REF_ALLOWED_KEYS = capturedFreeze(['mutated']);
export const PROTECTED_REF_REQUIRED_KEYS = PROTECTED_REF_ALLOWED_KEYS;
export const LANE_ALLOWED_KEYS = capturedFreeze([
  'accepted', 'assignment_id', 'provider', 'required', 'role', 'status',
]);
export const LANE_REQUIRED_KEYS = LANE_ALLOWED_KEYS;
export const RESULT_KEYS = capturedFreeze([
  'artifacts', 'attribution', 'blockers', 'candidate', 'checks', 'ci',
  'label', 'merge', 'pr', 'protected_ref', 'push', 'ready_for_sol_merge',
  'schema', 'side_effects', 'summary', 'tests', 'topology', 'truncation',
  'verifier', 'version', 'worktree',
]);
export const TRUNCATION_KEYS = capturedFreeze([
  'fields', 'omitted', 'original_count', 'reason', 'retained', 'truncated',
]);
export const MERGE_KEYS = capturedFreeze([
  'actor', 'card_can_merge', 'cas', 'sol_regular_merge_permitted',
]);
export const SUMMARY_KEYS = capturedFreeze([
  'blocker_count', 'branch', 'ci', 'head', 'pr', 'push', 'ready_for_sol_merge',
  'text', 'tree', 'worktree',
]);

export const FINAL_DECISION_CARD_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'aliased_reference_denied', 'bounds_exceeded',
  'exotic_prototype_denied', 'identity_mismatch', 'invalid_format',
  'invalid_type', 'missing_key', 'non_enumerable_property_denied',
  'out_of_range', 'own_undefined_denied', 'proxy_denied', 'symbol_key_denied',
  'unknown_key', 'value_depth_exceeded',
]);

const DEFINE = Object.defineProperty;
const IS_INT = Number.isSafeInteger;
const STRING = String;
const BYTE_LENGTH = NodeBuffer.byteLength.bind(NodeBuffer);
const IS_ARRAY = capturedIsArray;
const OWN_KEYS = capturedOwnKeys;
const SET_CTOR = Set;
const HASH = createHash;
const HASH_DIGEST = Object.getPrototypeOf(HASH('sha256')).digest;
const HASH_UPDATE = Object.getPrototypeOf(HASH('sha256')).update;
const IS_PROXY = utilTypes.isProxy;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,7}$/u;
const PR_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PR_URL_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/pull\/[1-9][0-9]{0,8}$/u;

const MSG = capturedFreeze({
  accessor_property_denied: 'FinalDecisionCardV1 denies accessor inputs.',
  aliased_reference_denied: 'FinalDecisionCardV1 denies aliased inputs.',
  bounds_exceeded: 'FinalDecisionCardV1 exceeded a closed projection bound.',
  exotic_prototype_denied: 'FinalDecisionCardV1 denies exotic prototypes.',
  identity_mismatch: 'FinalDecisionCardV1 requires matching run and artifact identity.',
  invalid_format: 'FinalDecisionCardV1 rejected a value that violates a closed grammar.',
  invalid_type: 'FinalDecisionCardV1 rejected a non-JSON projection value.',
  missing_key: 'FinalDecisionCardV1 requires every canonical projection key.',
  non_enumerable_property_denied: 'FinalDecisionCardV1 denies non-enumerable properties.',
  out_of_range: 'FinalDecisionCardV1 rejected a value outside closed bounds.',
  own_undefined_denied: 'FinalDecisionCardV1 denies own undefined values.',
  proxy_denied: 'FinalDecisionCardV1 denies Proxy inputs.',
  symbol_key_denied: 'FinalDecisionCardV1 denies symbol keys.',
  unknown_key: 'FinalDecisionCardV1 rejects keys outside the closed vocabulary.',
  value_depth_exceeded: 'FinalDecisionCardV1 rejected nested input that exceeds closed depth.',
});
const CLOSURE_REMAP = capturedFreeze({
  accessor_property_denied: 'accessor_property_denied',
  aliased_reference_denied: 'aliased_reference_denied',
  exotic_prototype_denied: 'exotic_prototype_denied',
  invalid_array: 'invalid_type',
  invalid_json_type: 'invalid_type',
  invalid_json_value: 'invalid_type',
  invalid_type: 'invalid_type',
  non_enumerable_property_denied: 'non_enumerable_property_denied',
  own_undefined_denied: 'own_undefined_denied',
  proxy_denied: 'proxy_denied',
  symbol_key_denied: 'symbol_key_denied',
  value_depth_exceeded: 'value_depth_exceeded',
});

function freezeRecord(keys, values) {
  const snapshot = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!capturedHasOwn(values, key)) continue;
    DEFINE(snapshot, key, {
      value: values[key], enumerable: true, writable: false, configurable: false,
    });
  }
  return capturedFreeze(snapshot);
}

function freezeList(values) {
  const copy = [];
  for (let i = 0; i < values.length; i += 1) copy[i] = values[i];
  return capturedFreeze(copy);
}

function deny(code, pathLabel) {
  fail(code, pathLabel, MSG[code] ?? MSG.invalid_format);
}

function remapClosure(error, pathLabel) {
  if (error instanceof RunContractV1Error) {
    const mapped = CLOSURE_REMAP[error.code];
    if (typeof mapped === 'string') deny(mapped, pathLabel);
    if (capturedIncludes(FINAL_DECISION_CARD_ERROR_CODES, error.code)) {
      deny(error.code, pathLabel);
    }
  }
  deny('invalid_format', pathLabel);
}

function assertClosedObject(input, allowed, pathLabel) {
  if (input === undefined || input === null) deny('invalid_type', pathLabel);
  if (typeof input === 'object' || typeof input === 'function') {
    try { assertNotProxy(input, pathLabel); } catch (error) { remapClosure(error, pathLabel); }
  }
  if (typeof input !== 'object') deny('invalid_type', pathLabel);
  if (IS_ARRAY(input)) deny('invalid_type', pathLabel);
  try {
    assertDirectJsonClosure(input, pathLabel);
  } catch (error) { remapClosure(error, pathLabel); }
  let keys;
  try { keys = OWN_KEYS(input); } catch { deny('invalid_type', pathLabel); }
  if (keys.length > MAX_CARD_OBJECT_KEYS) deny('bounds_exceeded', pathLabel);
  const allowedSet = new SET_CTOR(allowed);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key === 'symbol') deny('symbol_key_denied', pathLabel);
    if (typeof key !== 'string' || BYTE_LENGTH(key, 'utf8') > MAX_CARD_KEY_BYTES) {
      deny('bounds_exceeded', pathLabel);
    }
    if (!allowedSet.has(key)) deny('unknown_key', pathLabel);
  }
  return input;
}

function requireKeys(input, keys, pathLabel) {
  for (let i = 0; i < keys.length; i += 1) {
    if (!hasOwn(input, keys[i])) deny('missing_key', pathLabel);
  }
}

function ownString(input, key, pathLabel, maxBytes = MAX_CARD_STRING_BYTES) {
  const value = ownDataValue(input, key, pathLabel);
  if (typeof value !== 'string') deny('invalid_type', pathLabel);
  if (BYTE_LENGTH(value, 'utf8') > maxBytes) deny('bounds_exceeded', pathLabel);
  return value;
}

function optionalOwn(input, key, pathLabel, read) {
  if (!hasOwn(input, key)) return undefined;
  return read(input, key, pathLabel);
}

function ownBoolean(input, key, pathLabel) {
  const value = ownDataValue(input, key, pathLabel);
  if (value !== true && value !== false) deny('invalid_type', pathLabel);
  return value;
}

function ownEnum(input, key, allowed, pathLabel) {
  const value = ownString(input, key, pathLabel);
  if (!capturedIncludes(allowed, value)) deny('invalid_format', pathLabel);
  return value;
}

function ownInt(input, key, pathLabel, min, max) {
  const value = ownDataValue(input, key, pathLabel);
  if (typeof value !== 'number' || !IS_INT(value) || value < min || value > max) {
    deny('out_of_range', pathLabel);
  }
  return value;
}

function ownSha40(input, key, pathLabel) {
  const value = ownString(input, key, pathLabel, 40);
  if (!isSha40(value)) deny('invalid_format', pathLabel);
  return value;
}

function ownSha256(input, key, pathLabel) {
  const value = ownString(input, key, pathLabel, 64);
  if (!capturedTest(SHA256_PATTERN, value)) deny('invalid_format', pathLabel);
  return value;
}

function ownBranch(input, key, pathLabel) {
  const value = ownString(input, key, pathLabel, 200);
  if (!capturedTest(BRANCH_PATTERN, value)) deny('invalid_format', pathLabel);
  return value;
}

function ownPrName(input, key, pathLabel) {
  const value = ownString(input, key, pathLabel, 64);
  if (!capturedTest(PR_NAME_PATTERN, value)) deny('invalid_format', pathLabel);
  return value;
}

function parseObservedIdentity(object, pathLabel) {
  return freezeRecord(OBSERVED_IDENTITY_KEYS, {
    observed_head: ownSha40(object, 'observed_head', `${pathLabel}.observed_head`),
    observed_tree: ownSha40(object, 'observed_tree', `${pathLabel}.observed_tree`),
    freshness: ownEnum(object, 'freshness', CI_FRESHNESS, `${pathLabel}.freshness`),
  });
}

function receiptBindsCandidate(receipt, candidate, headKey, treeKey) {
  return receipt.freshness === 'current'
    && receipt[headKey] === candidate.head
    && receipt[treeKey] === candidate.tree;
}

function deriveCanonicalPrUrl(pr, pathLabel) {
  const url = `https://${pr.host}/${pr.owner}/${pr.repo}/pull/${STRING(pr.number)}`;
  if (!capturedTest(PR_URL_PATTERN, url)) deny('invalid_format', pathLabel);
  return url;
}

function bindRunId(value, pathLabel) {
  try {
    assertRunId(value, pathLabel);
  } catch (error) {
    if (error instanceof RunContractV1Error) deny('invalid_format', pathLabel);
    deny('invalid_type', pathLabel);
  }
  return value;
}

function bindBaseSha(value, pathLabel) {
  try {
    assertBaseSha(value, pathLabel);
  } catch (error) {
    if (error instanceof RunContractV1Error) deny('invalid_format', pathLabel);
    deny('invalid_type', pathLabel);
  }
  return value;
}

function digestOf(value) {
  const hash = HASH('sha256');
  HASH_UPDATE.call(hash, canonicalJsonStringify(value));
  return HASH_DIGEST.call(hash, 'hex');
}

function emptySideEffects() {
  const values = {};
  for (let i = 0; i < CARD_SIDE_EFFECT_NONCLAIMS.length; i += 1) {
    values[CARD_SIDE_EFFECT_NONCLAIMS[i]] = false;
  }
  return freezeRecord(CARD_SIDE_EFFECT_NONCLAIMS, values);
}

function parseIdentity(input, pathLabel) {
  const object = assertClosedObject(input, IDENTITY_ALLOWED_KEYS, pathLabel);
  requireKeys(object, IDENTITY_REQUIRED_KEYS, pathLabel);
  return freezeRecord(IDENTITY_ALLOWED_KEYS, {
    run_id: bindRunId(ownString(object, 'run_id', pathLabel), pathLabel),
    base_sha: bindBaseSha(ownString(object, 'base_sha', pathLabel), pathLabel),
  });
}

function parseCandidate(input, pathLabel) {
  const object = assertClosedObject(input, CANDIDATE_ALLOWED_KEYS, pathLabel);
  requireKeys(object, CANDIDATE_REQUIRED_KEYS, pathLabel);
  const branch = ownBranch(object, 'branch', `${pathLabel}.branch`);
  const head = ownSha40(object, 'head', `${pathLabel}.head`);
  const tree = ownSha40(object, 'tree', `${pathLabel}.tree`);
  const composed = ownBoolean(object, 'composed', `${pathLabel}.composed`);
  return freezeRecord(CANDIDATE_ALLOWED_KEYS, { branch, composed, head, tree });
}

function parseWorktree(input, pathLabel) {
  const object = assertClosedObject(input, WORKTREE_ALLOWED_KEYS, pathLabel);
  requireKeys(object, WORKTREE_REQUIRED_KEYS, pathLabel);
  return freezeRecord(WORKTREE_ALLOWED_KEYS, {
    clean: ownBoolean(object, 'clean', `${pathLabel}.clean`),
    active_git_operation: ownEnum(
      object,
      'active_git_operation',
      ACTIVE_GIT_OPERATIONS,
      `${pathLabel}.active_git_operation`,
    ),
  });
}

function parseVerifier(input, pathLabel) {
  const object = assertClosedObject(input, VERIFIER_ALLOWED_KEYS, pathLabel);
  requireKeys(object, VERIFIER_REQUIRED_KEYS, pathLabel);
  const identity = parseObservedIdentity(object, pathLabel);
  return freezeRecord(VERIFIER_ALLOWED_KEYS, {
    accepted: ownBoolean(object, 'accepted', `${pathLabel}.accepted`),
    status: ownEnum(object, 'status', VERIFIER_STATUSES, `${pathLabel}.status`),
    observed_head: identity.observed_head,
    observed_tree: identity.observed_tree,
    freshness: identity.freshness,
  });
}

function parseTests(input, pathLabel) {
  const object = assertClosedObject(input, TESTS_ALLOWED_KEYS, pathLabel);
  requireKeys(object, TESTS_REQUIRED_KEYS, pathLabel);
  const identity = parseObservedIdentity(object, pathLabel);
  return freezeRecord(TESTS_ALLOWED_KEYS, {
    present: ownBoolean(object, 'present', `${pathLabel}.present`),
    passed: ownBoolean(object, 'passed', `${pathLabel}.passed`),
    observed_head: identity.observed_head,
    observed_tree: identity.observed_tree,
    freshness: identity.freshness,
  });
}

function parseCi(input, pathLabel) {
  const object = assertClosedObject(input, CI_ALLOWED_KEYS, pathLabel);
  requireKeys(object, CI_REQUIRED_KEYS, pathLabel);
  const identity = parseObservedIdentity(object, pathLabel);
  return freezeRecord(CI_ALLOWED_KEYS, {
    state: ownEnum(object, 'state', CI_STATES, `${pathLabel}.state`),
    freshness: identity.freshness,
    observed_head: identity.observed_head,
    observed_tree: identity.observed_tree,
    hidden_checks: ownBoolean(object, 'hidden_checks', `${pathLabel}.hidden_checks`),
    unknown_checks: ownBoolean(object, 'unknown_checks', `${pathLabel}.unknown_checks`),
  });
}

function parsePush(input, pathLabel) {
  const object = assertClosedObject(input, PUSH_ALLOWED_KEYS, pathLabel);
  requireKeys(object, PUSH_REQUIRED_KEYS, pathLabel);
  const identity = parseObservedIdentity(object, pathLabel);
  return freezeRecord(PUSH_ALLOWED_KEYS, {
    published: ownBoolean(object, 'published', `${pathLabel}.published`),
    force: ownBoolean(object, 'force', `${pathLabel}.force`),
    observed_head: identity.observed_head,
    observed_tree: identity.observed_tree,
    freshness: identity.freshness,
  });
}

function parsePr(input, pathLabel) {
  const object = assertClosedObject(input, PR_ALLOWED_KEYS, pathLabel);
  requireKeys(object, PR_REQUIRED_KEYS, pathLabel);
  const provider = ownEnum(object, 'provider', PR_PROVIDERS, `${pathLabel}.provider`);
  const host = ownEnum(object, 'host', PR_HOSTS, `${pathLabel}.host`);
  const snapshot = freezeRecord(PR_ALLOWED_KEYS, {
    provider,
    host,
    owner: ownPrName(object, 'owner', `${pathLabel}.owner`),
    repo: ownPrName(object, 'repo', `${pathLabel}.repo`),
    number: ownInt(object, 'number', `${pathLabel}.number`, 1, 999_999_999),
    target_branch: ownBranch(object, 'target_branch', `${pathLabel}.target_branch`),
    head: ownSha40(object, 'head', `${pathLabel}.head`),
    tree: ownSha40(object, 'tree', `${pathLabel}.tree`),
    state: ownEnum(object, 'state', PR_STATES, `${pathLabel}.state`),
    is_draft: ownBoolean(object, 'is_draft', `${pathLabel}.is_draft`),
    freshness: ownEnum(object, 'freshness', CI_FRESHNESS, `${pathLabel}.freshness`),
  });
  deriveCanonicalPrUrl(snapshot, pathLabel);
  return snapshot;
}

function parseTopology(input, pathLabel) {
  const object = assertClosedObject(input, TOPOLOGY_ALLOWED_KEYS, pathLabel);
  requireKeys(object, TOPOLOGY_REQUIRED_KEYS, pathLabel);
  return freezeRecord(TOPOLOGY_ALLOWED_KEYS, {
    digest: ownSha256(object, 'digest', `${pathLabel}.digest`),
    expected_digest: ownSha256(object, 'expected_digest', `${pathLabel}.expected_digest`),
  });
}

function parseProtectedRef(input, pathLabel) {
  const object = assertClosedObject(input, PROTECTED_REF_ALLOWED_KEYS, pathLabel);
  requireKeys(object, PROTECTED_REF_REQUIRED_KEYS, pathLabel);
  return freezeRecord(PROTECTED_REF_ALLOWED_KEYS, {
    mutated: ownBoolean(object, 'mutated', `${pathLabel}.mutated`),
  });
}

function parseLane(input, pathLabel) {
  const object = assertClosedObject(input, LANE_ALLOWED_KEYS, pathLabel);
  requireKeys(object, LANE_REQUIRED_KEYS, pathLabel);
  const assignmentId = ownString(object, 'assignment_id', `${pathLabel}.assignment_id`);
  if (!isAssignmentId(assignmentId)) deny('invalid_format', `${pathLabel}.assignment_id`);
  const provider = ownString(object, 'provider', `${pathLabel}.provider`);
  if (!isKnownProvider(provider)) deny('invalid_format', `${pathLabel}.provider`);
  const role = ownString(object, 'role', `${pathLabel}.role`);
  if (!isKnownRole(role)) deny('invalid_format', `${pathLabel}.role`);
  return freezeRecord(LANE_ALLOWED_KEYS, {
    assignment_id: assignmentId,
    provider,
    required: ownBoolean(object, 'required', `${pathLabel}.required`),
    role,
    status: ownEnum(object, 'status', LANE_STATUSES, `${pathLabel}.status`),
    accepted: ownBoolean(object, 'accepted', `${pathLabel}.accepted`),
  });
}

function parseLanes(input, pathLabel) {
  try { assertNotProxy(input, pathLabel); } catch (error) { remapClosure(error, pathLabel); }
  try { assertDenseJsonArray(input, pathLabel); } catch (error) { remapClosure(error, pathLabel); }
  if (input.length < MIN_ASSIGNMENTS || input.length > MAX_ASSIGNMENTS) {
    deny('bounds_exceeded', pathLabel);
  }
  const lanes = [];
  const seen = new SET_CTOR();
  for (let i = 0; i < input.length; i += 1) {
    const lane = parseLane(input[i], `${pathLabel}[${i}]`);
    if (seen.has(lane.assignment_id)) deny('invalid_format', `${pathLabel}[${i}].assignment_id`);
    seen.add(lane.assignment_id);
    lanes.push(lane);
  }
  lanes.sort((left, right) => {
    if (left.assignment_id === right.assignment_id) return 0;
    return left.assignment_id < right.assignment_id ? -1 : 1;
  });
  return freezeList(lanes);
}

function parseArtifacts(input, identity, assignmentIds, pathLabel) {
  if (input === undefined) {
    return {
      artifacts: freezeList([]),
      original_count: 0,
      omitted: 0,
      truncated: false,
      unknown_assignment: false,
    };
  }
  try { assertNotProxy(input, pathLabel); } catch (error) { remapClosure(error, pathLabel); }
  try { assertDenseJsonArray(input, pathLabel); } catch (error) { remapClosure(error, pathLabel); }
  if (input.length > MAX_ARTIFACT_INPUT) deny('bounds_exceeded', pathLabel);
  const parsed = [];
  let unknownAssignment = false;
  for (let i = 0; i < input.length; i += 1) {
    let snapshot;
    try {
      snapshot = parseArtifactRefV1(input[i], `${pathLabel}[${i}]`);
    } catch (error) {
      remapClosure(error, `${pathLabel}[${i}]`);
    }
    if (snapshot.run_id !== identity.run_id) deny('identity_mismatch', `${pathLabel}[${i}].run_id`);
    if (!assignmentIds.has(snapshot.assignment_id)) unknownAssignment = true;
    parsed.push(snapshot);
  }
  parsed.sort((left, right) => compareArtifactRefsV1(left, right));
  for (let i = 1; i < parsed.length; i += 1) {
    if (compareArtifactRefsV1(parsed[i - 1], parsed[i]) === 0) {
      deny('invalid_format', pathLabel);
    }
  }
  const originalCount = parsed.length;
  const truncated = originalCount > MAX_ARTIFACT_RETAINED;
  const retained = truncated ? parsed.slice(0, MAX_ARTIFACT_RETAINED) : parsed;
  return {
    artifacts: freezeList(retained),
    original_count: originalCount,
    omitted: truncated ? originalCount - MAX_ARTIFACT_RETAINED : 0,
    truncated,
    unknown_assignment: unknownAssignment,
  };
}

function topologyDigestFromLanes(lanes) {
  const members = [];
  for (let i = 0; i < lanes.length; i += 1) {
    members.push(freezeRecord(
      ['assignment_id', 'provider', 'required', 'role'],
      {
        assignment_id: lanes[i].assignment_id,
        provider: lanes[i].provider,
        required: lanes[i].required,
        role: lanes[i].role,
      },
    ));
  }
  return digestOf(members);
}

function derivePushState(push) {
  if (push.force === true) return 'force';
  if (push.published !== true) return 'unpublished';
  return 'published-non-force';
}

function collectBlockers(facts) {
  const found = new SET_CTOR();
  if (facts.candidate.composed !== true) found.add('candidate_not_composed');
  if (facts.worktree.clean !== true) found.add('dirty_worktree');
  if (facts.worktree.active_git_operation !== ACCEPTED_GIT_OPERATION) {
    found.add('active_git_operation');
  }
  if (facts.verifier.accepted !== true || facts.verifier.status !== 'verified') {
    found.add('missing_verifier_acceptance');
  }
  if (facts.tests.present !== true || facts.tests.passed !== true) {
    found.add('tests_not_passed');
  }
  if (facts.ci.hidden_checks === true || facts.ci.state === 'hidden') found.add('hidden_checks');
  if (facts.ci.unknown_checks === true || facts.ci.state === 'unknown') found.add('unknown_checks');
  const candidate = facts.candidate;
  if (
    facts.verifier.observed_head !== candidate.head
    || facts.tests.observed_head !== candidate.head
    || facts.ci.observed_head !== candidate.head
    || facts.push.observed_head !== candidate.head
    || facts.pr.head !== candidate.head
  ) {
    found.add('missing_candidate_head');
  }
  if (
    facts.verifier.observed_tree !== candidate.tree
    || facts.tests.observed_tree !== candidate.tree
    || facts.ci.observed_tree !== candidate.tree
    || facts.push.observed_tree !== candidate.tree
    || facts.pr.tree !== candidate.tree
  ) {
    found.add('missing_candidate_tree');
  }
  if (
    facts.ci.freshness === 'stale'
    || facts.ci.state === 'stale'
    || facts.ci.observed_head !== candidate.head
    || facts.ci.observed_tree !== candidate.tree
  ) {
    found.add('stale_ci');
  }
  if (
    facts.verifier.freshness !== 'current'
    || facts.tests.freshness !== 'current'
    || facts.push.freshness !== 'current'
    || facts.pr.freshness !== 'current'
  ) {
    found.add('stale_evidence');
  }
  if (facts.ci.state !== 'green' || facts.cas.current_green_ci !== true) found.add('ci_not_green');
  if (facts.push.force === true) found.add('force_push');
  if (facts.push.published !== true) found.add('unpublished_head');
  if (
    facts.pr.is_draft !== true
    || facts.pr.state !== ACCEPTED_PR_STATE
    || facts.pr.provider !== 'github'
    || facts.pr.host !== 'github.com'
  ) {
    found.add('missing_draft_pr');
  }
  if (facts.pr.head !== candidate.head || facts.pr.tree !== candidate.tree) {
    found.add('mismatched_pr_head');
  }
  if (facts.topology.current !== true) found.add('missing_topology');
  if (facts.protected_ref.mutated === true) found.add('protected_ref_mutation');
  let unresolved = false;
  let requiredFailed = false;
  for (let i = 0; i < facts.lanes.length; i += 1) {
    const lane = facts.lanes[i];
    const requiredAccepted = lane.required !== true
      || (lane.accepted === true && lane.status === ACCEPTED_LANE_STATUS);
    if (lane.required === true && requiredAccepted !== true) {
      if (capturedIncludes(FAILED_LANE_STATUSES, lane.status)) requiredFailed = true;
      else unresolved = true;
    }
    if (
      lane.status === 'unresolved'
      || capturedIncludes(NONTERMINAL_LANE_STATUSES, lane.status)
    ) {
      unresolved = true;
    }
  }
  if (unresolved) found.add('unresolved_lanes');
  if (requiredFailed) found.add('partial_provider_failure');
  if (facts.unknown_assignment === true) found.add('unknown_assignment');
  const blockers = [];
  for (let i = 0; i < BLOCKER_CODES.length; i += 1) {
    if (found.has(BLOCKER_CODES[i])) blockers.push(BLOCKER_CODES[i]);
  }
  if (blockers.length > MAX_BLOCKERS) deny('bounds_exceeded', 'blockers');
  return freezeList(blockers);
}

function compactPr(pr) {
  return `${pr.host}/${pr.owner}/${pr.repo}#${STRING(pr.number)} -> ${pr.target_branch}`;
}

function clipSummaryText(text) {
  if (capturedUtf8ByteLength(text) <= MAX_SUMMARY_BYTES) return text;
  const encoded = NodeBuffer.from(text, 'utf8');
  let end = MAX_SUMMARY_BYTES - 3;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return `${encoded.subarray(0, end).toString('utf8')}…`;
}

function projectSummary(facts, ready, blockers) {
  const ciLabel = facts.cas.current_green_ci === true
    ? 'current-green'
    : (capturedIncludes(blockers, 'stale_ci')
      ? 'stale'
      : (capturedIncludes(blockers, 'hidden_checks')
        ? 'hidden'
        : (capturedIncludes(blockers, 'unknown_checks') ? 'unknown' : facts.ci.state)));
  const text = clipSummaryText([
    facts.candidate.branch,
    facts.candidate.head,
    facts.candidate.tree,
    facts.worktree.clean === true ? 'clean' : 'dirty',
    ciLabel,
    facts.push.state,
    compactPr(facts.pr),
    ready === true ? 'ready_for_sol_merge' : `blocked:${STRING(blockers.length)}`,
  ].join(' '));
  return freezeRecord(SUMMARY_KEYS, {
    branch: facts.candidate.branch,
    head: facts.candidate.head,
    tree: facts.candidate.tree,
    worktree: facts.worktree.clean === true ? 'clean' : 'dirty',
    ci: ciLabel,
    push: facts.push.state,
    pr: compactPr(facts.pr),
    ready_for_sol_merge: ready,
    blocker_count: blockers.length,
    text,
  });
}

function parseRequest(input) {
  if (IS_PROXY(input)) deny('proxy_denied', 'request');
  const object = assertClosedObject(input, INPUT_ALLOWED_KEYS, 'request');
  requireKeys(object, INPUT_REQUIRED_KEYS, 'request');
  const schema = ownString(object, 'schema', 'request.schema', MAX_CARD_STRING_BYTES);
  if (schema !== FINAL_DECISION_CARD_SCHEMA_ID) deny('invalid_format', 'request.schema');
  const version = ownDataValue(object, 'version', 'request.version');
  if (version !== FINAL_DECISION_CARD_VERSION) deny('invalid_format', 'request.version');
  const identity = parseIdentity(ownDataValue(object, 'identity', 'identity'), 'identity');
  const candidate = parseCandidate(ownDataValue(object, 'candidate', 'candidate'), 'candidate');
  const worktree = parseWorktree(ownDataValue(object, 'worktree', 'worktree'), 'worktree');
  const verifier = parseVerifier(ownDataValue(object, 'verifier', 'verifier'), 'verifier');
  const tests = parseTests(ownDataValue(object, 'tests', 'tests'), 'tests');
  const ci = parseCi(ownDataValue(object, 'ci', 'ci'), 'ci');
  const push = parsePush(ownDataValue(object, 'push', 'push'), 'push');
  const pr = parsePr(ownDataValue(object, 'pr', 'pr'), 'pr');
  const topology = parseTopology(ownDataValue(object, 'topology', 'topology'), 'topology');
  const protectedRef = parseProtectedRef(
    ownDataValue(object, 'protected_ref', 'protected_ref'),
    'protected_ref',
  );
  const lanes = parseLanes(ownDataValue(object, 'lanes', 'lanes'), 'lanes');
  const assignmentIds = new SET_CTOR();
  for (let i = 0; i < lanes.length; i += 1) assignmentIds.add(lanes[i].assignment_id);
  const artifacts = parseArtifacts(
    optionalOwn(object, 'artifacts', 'artifacts', (src, key, label) => ownDataValue(src, key, label)),
    identity,
    assignmentIds,
    'artifacts',
  );
  return {
    identity, candidate, worktree, verifier, tests, ci, push, pr, topology,
    protected_ref: protectedRef, lanes, artifacts,
  };
}

function evaluate(parsed) {
  const computedTopology = topologyDigestFromLanes(parsed.lanes);
  const topologyCurrent = parsed.topology.digest === parsed.topology.expected_digest
    && parsed.topology.digest === computedTopology;
  const candidate = parsed.candidate;
  const evidenceBound = receiptBindsCandidate(parsed.verifier, candidate, 'observed_head', 'observed_tree')
    && receiptBindsCandidate(parsed.tests, candidate, 'observed_head', 'observed_tree')
    && receiptBindsCandidate(parsed.ci, candidate, 'observed_head', 'observed_tree')
    && receiptBindsCandidate(parsed.push, candidate, 'observed_head', 'observed_tree')
    && receiptBindsCandidate(parsed.pr, candidate, 'head', 'tree');
  const exactHead = isSha40(candidate.head) && evidenceBound === true;
  const exactTree = isSha40(candidate.tree) && evidenceBound === true;
  const currentGreenCi = parsed.ci.state === 'green'
    && parsed.ci.freshness === 'current'
    && parsed.ci.hidden_checks === false
    && parsed.ci.unknown_checks === false
    && parsed.ci.observed_head === candidate.head
    && parsed.ci.observed_tree === candidate.tree;
  const cas = freezeRecord(SOL_CAS_CHECKS, {
    exact_head: exactHead,
    exact_tree: exactTree,
    current_green_ci: currentGreenCi,
    topology: topologyCurrent,
  });
  const facts = {
    candidate: parsed.candidate,
    worktree: parsed.worktree,
    verifier: parsed.verifier,
    tests: parsed.tests,
    ci: parsed.ci,
    push: {
      published: parsed.push.published,
      force: parsed.push.force,
      observed_head: parsed.push.observed_head,
      observed_tree: parsed.push.observed_tree,
      freshness: parsed.push.freshness,
      state: derivePushState(parsed.push),
    },
    pr: parsed.pr,
    topology: freezeRecord(['computed_digest', 'current', 'digest', 'expected_digest'], {
      digest: parsed.topology.digest,
      expected_digest: parsed.topology.expected_digest,
      computed_digest: computedTopology,
      current: topologyCurrent,
    }),
    protected_ref: parsed.protected_ref,
    lanes: parsed.lanes,
    unknown_assignment: parsed.artifacts.unknown_assignment === true,
    cas,
  };
  const blockers = collectBlockers(facts);
  const ready = blockers.length === 0
    && cas.exact_head === true
    && cas.exact_tree === true
    && cas.current_green_ci === true
    && cas.topology === true;
  return { facts, blockers, ready, cas };
}

export function describeFinalDecisionCardV1() {
  return freezeData(capturedFreeze({
    schema: FINAL_DECISION_CARD_SCHEMA_ID,
    version: FINAL_DECISION_CARD_VERSION,
    result_schema: FINAL_DECISION_CARD_RESULT_SCHEMA_ID,
    rule: 'typed_facts_only_never_provider_prose',
    api: capturedFreeze(['describeFinalDecisionCardV1', 'projectFinalDecisionCardV1']),
    public_labels: PUBLIC_LABELS,
    blocker_codes: BLOCKER_CODES,
    checks: CARD_CHECKS,
    error_codes: FINAL_DECISION_CARD_ERROR_CODES,
    side_effect_nonclaims: CARD_SIDE_EFFECT_NONCLAIMS,
    sol_regular_merge_actor: SOL_REGULAR_MERGE_ACTOR,
    sol_cas_checks: SOL_CAS_CHECKS,
    card_can_merge: false,
    max_object_keys: MAX_CARD_OBJECT_KEYS,
    max_key_bytes: MAX_CARD_KEY_BYTES,
    max_string_bytes: MAX_CARD_STRING_BYTES,
    max_summary_bytes: MAX_SUMMARY_BYTES,
    max_artifact_input: MAX_ARTIFACT_INPUT,
    max_artifact_retained: MAX_ARTIFACT_RETAINED,
    max_blockers: MAX_BLOCKERS,
    max_lanes: MAX_ASSIGNMENTS,
    composed_surfaces: capturedFreeze({
      git: 'not invoked',
      filesystem: 'not invoked',
      process: 'not invoked',
      network: 'not invoked',
      provider: 'not invoked',
      credentials: 'not accessed',
      supervisor_server: 'no cutover',
      public_mcp: 'not exposed',
      ui: 'not owned',
      merge: 'denied; sol_high_xhigh may regular-merge after CAS',
      gate_a: 'not claimed',
      remote_mutation: 'denied',
    }),
  }));
}

export function projectFinalDecisionCardV1(input) {
  const parsed = parseRequest(input);
  const evaluated = evaluate(parsed);
  const ready = evaluated.ready === true;
  const truncation = freezeRecord(TRUNCATION_KEYS, {
    truncated: parsed.artifacts.truncated,
    fields: freezeList(parsed.artifacts.truncated ? ['artifacts'] : []),
    original_count: parsed.artifacts.original_count,
    retained: parsed.artifacts.artifacts.length,
    omitted: parsed.artifacts.omitted,
    reason: parsed.artifacts.truncated ? ARTIFACT_TRUNCATION_REASON : null,
  });
  const card = freezeRecord(RESULT_KEYS, {
    schema: FINAL_DECISION_CARD_RESULT_SCHEMA_ID,
    version: FINAL_DECISION_CARD_VERSION,
    label: ready ? PUBLIC_LABEL_READY : PUBLIC_LABEL_BLOCKED,
    ready_for_sol_merge: ready,
    blockers: evaluated.blockers,
    candidate: freezeRecord(['branch', 'composed', 'head', 'tree'], parsed.candidate),
    worktree: freezeRecord(['active_git_operation', 'clean', 'state'], {
      clean: parsed.worktree.clean,
      state: parsed.worktree.clean === true ? 'clean' : 'dirty',
      active_git_operation: parsed.worktree.active_git_operation,
    }),
    verifier: freezeRecord(VERIFIER_ALLOWED_KEYS, parsed.verifier),
    tests: freezeRecord(TESTS_ALLOWED_KEYS, parsed.tests),
    ci: freezeRecord(CI_ALLOWED_KEYS, parsed.ci),
    push: freezeRecord(['force', 'freshness', 'observed_head', 'observed_tree', 'published', 'state'], {
      published: parsed.push.published,
      force: parsed.push.force,
      observed_head: parsed.push.observed_head,
      observed_tree: parsed.push.observed_tree,
      freshness: parsed.push.freshness,
      state: evaluated.facts.push.state,
    }),
    pr: freezeRecord(PR_RESULT_KEYS, {
      provider: parsed.pr.provider,
      host: parsed.pr.host,
      owner: parsed.pr.owner,
      repo: parsed.pr.repo,
      number: parsed.pr.number,
      target_branch: parsed.pr.target_branch,
      head: parsed.pr.head,
      tree: parsed.pr.tree,
      state: parsed.pr.state,
      is_draft: parsed.pr.is_draft,
      freshness: parsed.pr.freshness,
      url: deriveCanonicalPrUrl(parsed.pr, 'pr'),
    }),
    attribution: parsed.lanes,
    topology: evaluated.facts.topology,
    protected_ref: freezeRecord(PROTECTED_REF_ALLOWED_KEYS, parsed.protected_ref),
    summary: projectSummary(evaluated.facts, ready, evaluated.blockers),
    artifacts: parsed.artifacts.artifacts,
    truncation,
    merge: freezeRecord(MERGE_KEYS, {
      card_can_merge: false,
      actor: SOL_REGULAR_MERGE_ACTOR,
      sol_regular_merge_permitted: ready,
      cas: evaluated.cas,
    }),
    checks: CARD_CHECKS,
    side_effects: emptySideEffects(),
  });
  return freezeData(card);
}

capturedFreeze(projectFinalDecisionCardV1);
capturedFreeze(describeFinalDecisionCardV1);
