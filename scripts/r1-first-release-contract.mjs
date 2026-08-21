export const R1_VERSION = '3.3.0';
export const COMPATIBLE_VERSION = '3.2.1';

export const ADR_RELATIVE = 'docs/adr/0001-r1-bounded-run-architecture.md';
export const THREAT_MODEL_RELATIVE = 'docs/threat-model.md';

export const ARCHITECTURE_IDS = Object.freeze([
  'bounded_run_1_to_8',
  'immutable_repo_base_identity',
  'deterministic_explicit_or_profile_resolution',
  'no_direct_mode_for_run_submissions',
  'disjoint_writer_scopes',
  'read_only_verification',
  'no_post_dispatch_fallback_or_replay',
  'exact_identities',
  'bounded_evidence',
  'codex_only_final_acceptance',
  'additive_3_2_1_compatibility',
  'run_owned_candidate_composition',
  'attention_batch_v1',
  'gate_a_functional_release',
  'gate_b_advisory_context_efficiency',
  'gate_c_advisory_credit_economics',
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
  'cgroup_lifecycle_not_sandbox',
  'raw_evidence_owner_only_local',
  'sanitized_bounded_evidence_model_facing',
  'trusted_verification_policy_command_catalog',
  'manual_proof_bound_cleanup',
  'no_automatic_gc',
]);

const FORBIDDEN_MAJOR = '4.0.0';

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
  for (const id of NON_GOAL_IDS) requireId(adrText, id, 'ADR');
  for (const id of ALLOWED_IDS) requireId(adrText, id, 'ADR');
  for (const id of THREAT_MODEL_IDS) requireId(threatText, id, 'threat model');

  const adrNonGoals = backtickIds(adrText, 'Machine-checked first-release non-goal identifiers');
  const adrAllowed = backtickIds(adrText, 'Machine-checked first-release allowed mechanisms');
  for (const id of NON_GOAL_IDS) {
    if (!listHas(adrNonGoals, id)) fail(`ADR non-goal list is missing ${id}.`);
    if (listHas(adrAllowed, id)) fail(`ADR allowed-mechanism list must not include non-goal ${id}.`);
  }
  for (const id of ALLOWED_IDS) {
    if (!listHas(adrAllowed, id)) fail(`ADR allowed-mechanism list is missing ${id}.`);
    if (listHas(adrNonGoals, id)) fail(`ADR non-goals must not forbid allowed mechanism ${id}.`);
  }

  requirePhrase(
    adrText,
    /platform \*\*MAY\*\* deterministically compose frozen verified child deltas/iu,
    'ADR',
  );
  requirePhrase(adrText, /exact and non-conflict-resolving/iu, 'ADR');
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
  requirePhrase(adrText, /AttentionBatchV1/u, 'ADR');
  requirePhrase(adrText, /at most one execution reply round/iu, 'ADR');
  requirePhrase(
    adrText,
    /Unsupported questions become \*\*unresolved\*\* and the affected assignment is \*\*safely cancelled\*\*/iu,
    'ADR',
  );
  requirePhrase(adrText, /Gate B and Gate C may be recorded as evidence/iu, 'ADR');
  requirePhrase(adrText, /Only Gate A is the functional release authority/iu, 'ADR');
  requirePhrase(adrText, /run submissions\*\* reject direct mode/iu, 'ADR');
  requirePhrase(adrText, /never replayed/iu, 'ADR');

  requirePhrase(threatText, /full repository/iu, 'threat model');
  requirePhrase(threatText, /accidentally committed/iu, 'threat model');
  requirePhrase(threatText, /not a sandbox/iu, 'threat model');
  requirePhrase(threatText, /Raw evidence/u, 'threat model');
  requirePhrase(threatText, /Sanitized bounded evidence/u, 'threat model');
  requirePhrase(threatText, /only executable command catalog/iu, 'threat model');
  requirePhrase(threatText, /proof-bound/iu, 'threat model');
  requirePhrase(threatText, /no automatic garbage collection/iu, 'threat model');
  requirePhrase(
    threatText,
    /do not forbid `run_owned_candidate_composition` or `manual_proof_bound_cleanup`/iu,
    'threat model',
  );

  requirePhrase(securityText, /Codex is the only final acceptance and integration authority/u, 'SECURITY.md');
  requirePhrase(securityText, /full repository/iu, 'SECURITY.md');
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
