export const R1_VERSION = '3.3.0';
export const COMPATIBLE_VERSION = '3.2.1';

export const ADR_RELATIVE = 'docs/adr/0001-r1-bounded-run-architecture.md';
export const THREAT_MODEL_RELATIVE = 'docs/threat-model.md';

export const ARCHITECTURE_IDS = Object.freeze([
  'bounded_run_1_to_8',
  'immutable_repo_base_identity',
  'deterministic_explicit_or_profile_resolution',
  'profiles_data_only',
  'verification_policy_v1_only_executable_catalog',
  'codex_selects_approved_command_ids_only',
  'manifests_carry_command_ids_not_argv',
  'provider_commands_evidence_never_auto_executed',
  'no_direct_mode_for_run_submissions',
  'run_cloud_lane_requires_pinned_starting_ref',
  'disjoint_writer_scopes',
  'read_only_verification',
  'no_post_dispatch_fallback_or_replay',
  'exact_identities',
  'bounded_evidence',
  'codex_only_final_acceptance',
  'additive_3_2_1_compatibility',
  'run_owned_candidate_composition',
  'candidate_binary_safe_manifest_order',
  'candidate_git_policy_revalidation',
  'run_owned_candidate_ref_namespace',
  'diagnostic_partial_candidate_never_ready',
  'attention_batch_v1',
  'attention_deadlines_not_silently_extended',
  'gate_a_functional_release',
  'gate_b_advisory_context_efficiency',
  'gate_c_advisory_credit_economics',
]);

export const GATE_A_OBLIGATION_IDS = Object.freeze([
  'gate_a_no_duplicate_dispatch',
  'gate_a_exact_run_child_provider_workspace_git_identity',
  'gate_a_idempotent_submission',
  'gate_a_assignment_count_1_to_8',
  'gate_a_scope_and_read_only_detection',
  'gate_a_candidate_composition_and_combined_verification',
  'gate_a_decision_evidence',
  'gate_a_decision_or_attention_no_silent_unanswerable',
  'gate_a_cancellation_restart_cursor_recovery',
  'gate_a_no_protected_ref_mutation',
  'gate_a_valid_raw_and_sanitized_artifacts',
  'gate_a_constrained_trusted_policy_command_execution',
  'gate_a_safe_per_run_cleanup',
  'gate_a_additive_3_2_1_compatibility',
  'gate_a_every_advertised_provider_route',
  'gate_a_real_host_5_30_240_minute_waits',
  'gate_a_exact_tree_package_necessary_not_sufficient',
]);

export const PROFILE_BOUNDARY_IDS = Object.freeze([
  'profiles_data_only',
  'verification_policy_v1_only_executable_catalog',
  'codex_selects_approved_command_ids_only',
  'manifests_carry_command_ids_not_argv',
  'provider_commands_evidence_never_auto_executed',
]);

export const NON_GOAL_IDS = Object.freeze([
  'semantic_or_vector_memory',
  'cross_run_knowledge_or_search',
  'llm_global_compression',
  'learned_routing_or_cost_prediction',
  'general_dag_or_branch_inheritance',
  'agent_messaging_or_dynamic_spawning_beyond_submitted_8',
  'debate_consensus_or_automatic_repair',
  'protected_branch_integration',
  'automatic_gc',
]);

export const ALLOWED_IDS = Object.freeze([
  'run_owned_candidate_composition',
  'manual_proof_bound_cleanup',
]);

export const THREAT_MODEL_IDS = Object.freeze([
  'codex_only_final_acceptance',
  'full_repository_provider_exposure',
  'platform_protected_credentials_refs_tokens_excluded',
  'cursor_cloud_origin_operator_authorized_only',
  'cgroup_lifecycle_not_sandbox',
  'raw_evidence_owner_only_local',
  'sanitized_bounded_evidence_model_facing',
  'trusted_verification_policy_command_catalog',
  'profiles_data_only',
  'verification_policy_v1_only_executable_catalog',
  'provider_commands_evidence_never_auto_executed',
  'manual_proof_bound_cleanup',
  'no_automatic_gc',
]);

const FORBIDDEN_MAJOR = '4.0.0';

const FORBIDDEN_PROFILE_EXECUTABLE_PATTERNS = Object.freeze([
  [
    /A profile may name provider, role, expected duration, and a verification/iu,
    'legacy profile command-catalog sentence',
  ],
  [
    /profiles?\s+(?:may|can|might)\s+(?:name|define|contain|include|carry)\b[^\n.]{0,120}(?<![\w-])(?:verification command catalog|command catalog|command templates?|executables?|argv|shell strings?)(?![\w-])/iu,
    'profile executable-catalog authorization',
  ],
  [
    /profiles?\s+(?:are|remain)\s+(?:allowed|permitted)\s+to\s+(?:name|define|contain|include|carry)\b[^\n.]{0,120}(?<![\w-])(?:command catalog|executables?|argv)(?![\w-])/iu,
    'profile executable-catalog permission',
  ],
  [
    /(?:verification\s+)?catalog\b[^\n.]{0,80}\binside\s+(?:a\s+)?profiles?\b[^\n.]{0,80}\b(?:may|can|might)\s+(?:contain|include|carry|define|name)\b[^\n.]{0,80}\b(?:runnable\s+)?command(?:\s+entries)?\b/iu,
    'profile-contained runnable command catalog',
  ],
]);

const FORBIDDEN_PROVIDER_COMMAND_EXECUTION_PATTERNS = Object.freeze([
  [
    /provider-(?:reported|requested)(?:\s*(?:\/|or)\s*(?:provider-)?(?:reported|requested))?\s+commands?\s+(?:(?:may|can|might|will|shall|must)\s+(?:be\s+)?|(?:are|is|get|gets|got)\s+)(?:automatically\s+)?(?:executed|run|auto-executed)(?:\s+automatically)?\b/iu,
    'provider-command execution authorization',
  ],
  [
    /(?:allows?|allowed|allowing|permits?|permitted|permitting|approves?|approved|approving|authorizes?|authorized|authorizing)\b[^\n.]{0,120}\bprovider-(?:reported|requested)(?:\s*(?:\/|or)\s*(?:provider-)?(?:reported|requested))?\s+commands?\b[^\n.]{0,120}\b(?:to\s+(?:be\s+)?(?:execute|executed|run)|for\s+(?:automatic\s+)?execution|as\s+execution\s+authority)\b/iu,
    'provider-command approval as execution authority',
  ],
  [
    /(?:\bautomatically\s+(?:executes?|runs?)|\bauto-(?:executes?|runs?))\s+provider-(?:reported|requested)(?:\s*(?:\/|or)\s*(?:provider-)?(?:reported|requested))?\s+commands?\b/iu,
    'provider-command actor auto-execution',
  ],
  [
    /\b(?:executes?|runs?)\s+provider-(?:reported|requested)(?:\s*(?:\/|or)\s*(?:provider-)?(?:reported|requested))?\s+commands?\s+automatically\b/iu,
    'provider-command actor trailing auto-execution',
  ],
  [
    /\b(?:execution|running)\s+of\s+provider-(?:reported|requested)(?:\s*(?:\/|or)\s*(?:provider-)?(?:reported|requested))?\s+commands?\b[^\n.]{0,120}\b(?:happens?|occurs?|proceeds?)\s+automatically\b/iu,
    'provider-command automatic-execution nominalization',
  ],
  [
    /\bapproval\s+of\s+provider-(?:reported|requested)(?:\s*(?:\/|or)\s*(?:provider-)?(?:reported|requested))?\s+commands?\b[^\n.]{0,120}\bauthoriz(?:es?|ed|ing)\s+(?:automatic\s+)?execution\b/iu,
    'provider-command approval nominalization',
  ],
]);

function fail(message) {
  throw new Error(message);
}

function folded(source) {
  return String(source).replace(/\s+/gu, ' ');
}

function backtickIds(source, heading) {
  const headingIndex = source.indexOf(heading);
  if (headingIndex === -1) fail(`Missing heading ${heading}.`);
  const remainder = source.slice(headingIndex);
  const list = remainder.match(/:\s*\n((?:- `[a-z0-9_]+`\n)+)/u);
  if (!list) fail(`Missing identifier list after ${heading}.`);
  return [...list[1].matchAll(/`([a-z0-9_]+)`/gu)].map((match) => match[1]);
}

function requireId(source, id, label) {
  if (!source.includes(`\`${id}\``) && !source.includes(id)) {
    fail(`${label} is missing contract identifier ${id}.`);
  }
}

function requirePhrase(source, pattern, label) {
  if (!pattern.test(folded(source)) && !pattern.test(source)) {
    fail(`${label} is missing required phrasing ${pattern}.`);
  }
}

function listHas(ids, id) {
  return ids.includes(id);
}

function assertNoExecutableProfileCatalog(source, label) {
  const text = folded(source);
  for (const [pattern, name] of FORBIDDEN_PROFILE_EXECUTABLE_PATTERNS) {
    if (pattern.test(text) || pattern.test(source)) {
      fail(`${label} re-authorizes executable profile content (${name}).`);
    }
  }
}

function assertNoProviderCommandExecutionAuthorization(source, label) {
  const text = String(source)
    .replace(/(?:\r?\n){2,}/gu, '. ')
    .replace(/\s+/gu, ' ');
  for (const [pattern, name] of FORBIDDEN_PROVIDER_COMMAND_EXECUTION_PATTERNS) {
    if (hasUnnegatedMatch(text, pattern)) {
      fail(`${label} re-authorizes provider-command execution (${name}).`);
    }
  }
}

function hasUnnegatedMatch(source, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  for (const match of source.matchAll(matcher)) {
    const prefix = source.slice(Math.max(0, match.index - 320), match.index);
    if (isImmediatelyNegated(prefix)) continue;
    return true;
  }
  return false;
}

function isImmediatelyNegated(prefix) {
  const clause = prefix
    .split(/(?:[.;!?]|\bbut\b|\bhowever\b)/iu)
    .at(-1)
    .slice(-240);
  if (/\bnot\s+only\b/iu.test(clause)) return false;
  return /\b(?:may|might|must|shall|will|can|could|does?|did)\s+not\b/iu.test(clause)
    || /\b(?:never|cannot|can't)\b/iu.test(clause)
    || /\bno\s+(?:operator|worker|provider|verifier|platform|system)\b/iu.test(clause);
}

export function assertR1FirstReleaseContract({ adrText, threatText, securityText }) {
  if (typeof adrText !== 'string' || adrText.length === 0) fail('ADR text is required.');
  if (typeof threatText !== 'string' || threatText.length === 0) fail('Threat-model text is required.');
  if (typeof securityText !== 'string' || securityText.length === 0) fail('SECURITY.md text is required.');

  for (const [label, source] of [
    ['ADR', adrText],
    ['threat model', threatText],
    ['SECURITY.md', securityText],
  ]) {
    if (source.includes(FORBIDDEN_MAJOR)) {
      fail(`${label} must version R1 as ${R1_VERSION} and must not mention ${FORBIDDEN_MAJOR}.`);
    }
  }

  if (!adrText.includes(R1_VERSION)) fail(`ADR must name product version ${R1_VERSION}.`);
  if (!adrText.includes(COMPATIBLE_VERSION)) fail(`ADR must record additive ${COMPATIBLE_VERSION} compatibility.`);
  if (!threatText.includes(R1_VERSION)) fail(`Threat model must name product version ${R1_VERSION}.`);

  for (const id of ARCHITECTURE_IDS) requireId(adrText, id, 'ADR');
  for (const id of GATE_A_OBLIGATION_IDS) requireId(adrText, id, 'ADR');
  for (const id of PROFILE_BOUNDARY_IDS) requireId(adrText, id, 'ADR');
  for (const id of NON_GOAL_IDS) requireId(adrText, id, 'ADR');
  for (const id of ALLOWED_IDS) requireId(adrText, id, 'ADR');
  for (const id of THREAT_MODEL_IDS) requireId(threatText, id, 'threat model');

  const adrArchitecture = backtickIds(adrText, 'Machine-checked 3.3.0 architecture identifiers');
  const adrGateA = backtickIds(adrText, 'Machine-checked Gate A functional qualification identifiers');
  const adrNonGoals = backtickIds(adrText, 'Machine-checked first-release non-goal identifiers');
  const adrAllowed = backtickIds(adrText, 'Machine-checked first-release allowed mechanisms');
  const threatIds = backtickIds(threatText, 'Machine-checked authority and threat-model identifiers');

  for (const id of ARCHITECTURE_IDS) {
    if (!listHas(adrArchitecture, id)) fail(`ADR architecture list is missing ${id}.`);
  }
  for (const id of GATE_A_OBLIGATION_IDS) {
    if (!listHas(adrGateA, id)) fail(`ADR Gate A obligation list is missing ${id}.`);
  }
  for (const id of PROFILE_BOUNDARY_IDS) {
    if (!listHas(adrArchitecture, id)) fail(`ADR architecture list is missing profile-boundary id ${id}.`);
  }
  for (const id of NON_GOAL_IDS) {
    if (!listHas(adrNonGoals, id)) fail(`ADR non-goal list is missing ${id}.`);
    if (listHas(adrAllowed, id)) fail(`ADR allowed-mechanism list must not include non-goal ${id}.`);
  }
  for (const id of ALLOWED_IDS) {
    if (!listHas(adrAllowed, id)) fail(`ADR allowed-mechanism list is missing ${id}.`);
    if (listHas(adrNonGoals, id)) fail(`ADR non-goals must not forbid allowed mechanism ${id}.`);
  }
  for (const id of THREAT_MODEL_IDS) {
    if (!listHas(threatIds, id)) fail(`Threat-model identifier list is missing ${id}.`);
  }

  assertNoExecutableProfileCatalog(adrText, 'ADR');
  assertNoExecutableProfileCatalog(threatText, 'threat model');
  assertNoExecutableProfileCatalog(securityText, 'SECURITY.md');
  assertNoProviderCommandExecutionAuthorization(adrText, 'ADR');
  assertNoProviderCommandExecutionAuthorization(threatText, 'threat model');
  assertNoProviderCommandExecutionAuthorization(securityText, 'SECURITY.md');

  requirePhrase(adrText, /Profiles are \*\*data-only\*\*/u, 'ADR');
  requirePhrase(adrText, /VerificationPolicyV1/u, 'ADR');
  requirePhrase(adrText, /necessary\s+but not sufficient/iu, 'ADR');
  requirePhrase(adrText, /AttentionBatchV1/u, 'ADR');
  requirePhrase(adrText, /at most one execution reply round/iu, 'ADR');
  requirePhrase(adrText, /Gate B and Gate C may be recorded as evidence/iu, 'ADR');
  requirePhrase(adrText, /Only Gate A is the functional release authority/iu, 'ADR');
  requirePhrase(adrText, /run submissions\*\* reject direct mode/iu, 'ADR');
  requirePhrase(adrText, /never replayed/iu, 'ADR');
  requirePhrase(
    adrText,
    /individual 3\.2\.1 Cursor Cloud tasks, `starting_ref` remains optional/iu,
    'ADR',
  );
  requirePhrase(
    adrText,
    /Every 3\.3\.0 \*\*run\*\* Cloud lane \*\*MUST\*\* pin one exact already-pushed/iu,
    'ADR',
  );
  requirePhrase(
    adrText,
    /platform \*\*MAY\*\* deterministically compose frozen verified child deltas/iu,
    'ADR',
  );
  requirePhrase(adrText, /exact and non-conflict-resolving/iu, 'ADR');
  requirePhrase(adrText, /binary-safe delta[\s\S]{0,120}manifest\s+order/iu, 'ADR');
  requirePhrase(adrText, /Disallowed submodule, symlink, rename, or mode-change\s+behavior rejects the delta/iu, 'ADR');
  requirePhrase(adrText, /refs\/codex-co-engineer\/runs\/<run-id>\/candidate/u, 'ADR');
  requirePhrase(adrText, /`incomplete_candidate` and can never receive `ready_for_codex_review`/iu, 'ADR');
  requirePhrase(
    adrText,
    /MUST NOT\*\* integrate that candidate into a user branch, a protected branch, or a remote/iu,
    'ADR',
  );
  requirePhrase(
    adrText,
    /required writer lane that is rejected or unresolved blocks a complete candidate/iu,
    'ADR',
  );
  requirePhrase(
    adrText,
    /Unsupported questions become \*\*unresolved\*\* and the affected assignment is \*\*safely cancelled\*\*/iu,
    'ADR',
  );
  requirePhrase(adrText, /Waiting never silently extends a deadline/iu, 'ADR');
  requirePhrase(adrText, /explicit, audited lane-level deadline extension/iu, 'ADR');

  requirePhrase(threatText, /authorized full repository and history/iu, 'threat model');
  requirePhrase(threatText, /committed secrets/iu, 'threat model');
  requirePhrase(threatText, /Git\/hosting write credentials/iu, 'threat model');
  requirePhrase(threatText, /unrelated to the selected provider route/iu, 'threat model');
  requirePhrase(threatText, /owner-only raw evidence/iu, 'threat model');
  requirePhrase(threatText, /unauthorized refs/iu, 'threat model');
  requirePhrase(threatText, /not overclaim that the platform automatically strips/iu, 'threat model');
  requirePhrase(threatText, /not a sandbox/iu, 'threat model');
  requirePhrase(threatText, /Raw evidence/u, 'threat model');
  requirePhrase(threatText, /Sanitized bounded evidence/u, 'threat model');
  requirePhrase(threatText, /VerificationPolicyV1/u, 'threat model');
  requirePhrase(threatText, /never automatically executed/iu, 'threat model');
  requirePhrase(threatText, /proof-bound/iu, 'threat model');
  requirePhrase(threatText, /no automatic garbage collection/iu, 'threat model');
  requirePhrase(
    threatText,
    /do not forbid `run_owned_candidate_composition` or `manual_proof_bound_cleanup`/iu,
    'threat model',
  );

  requirePhrase(securityText, /Codex is the only final acceptance and integration authority/u, 'SECURITY.md');
  requirePhrase(securityText, /authorized full repository and history/iu, 'SECURITY.md');
  requirePhrase(securityText, /VerificationPolicyV1/u, 'SECURITY.md');
  requirePhrase(securityText, /docs\/threat-model\.md/u, 'SECURITY.md');
  requirePhrase(securityText, /no automatic garbage collection/iu, 'SECURITY.md');

  const forbiddenNonGoalPhrases = [
    [/must not compose frozen verified child deltas/iu, 'candidate composition'],
    [/forbid(?:s|ding)? run-owned candidate/iu, 'candidate composition'],
    [/automatic garbage collection is required/iu, 'manual cleanup'],
    [/must not (?:perform|allow) manual(?: run)? cleanup/iu, 'manual cleanup'],
  ];
  for (const [pattern, label] of forbiddenNonGoalPhrases) {
    if (pattern.test(folded(adrText)) || pattern.test(adrText)
      || pattern.test(folded(threatText)) || pattern.test(threatText)) {
      fail(`R1 docs must not forbid ${label}.`);
    }
  }
}
