// Neutral fixtures for RunApiBoundaryV1 tests. Construction only: already-
// produced P30/P31-shaped values, no Git, filesystem, process, network,
// provider, credential, or orchestration execution. Tests own the assertions.

import {
  PROTECTED_REF_AUDIT_CHECKS,
  PROTECTED_REF_AUDIT_SCHEMA_ID,
  PROTECTED_REF_AUDIT_SIDE_EFFECT_NONCLAIMS,
  PROTECTED_REF_AUDIT_VERSION,
} from '../../mcp/v3/protected-ref-audit.mjs';
import { GIT_IDENTITY_SCHEMA_ID } from '../../mcp/v3/protected-identity.mjs';
import {
  RUN_API_BOUNDARY_SCHEMA_ID,
  RUN_API_BOUNDARY_VERSION,
} from '../../mcp/v3/run-api-boundary.mjs';
import {
  RUN_ORCHESTRATION_CHECKS,
  RUN_ORCHESTRATION_SCHEMA_ID,
  RUN_ORCHESTRATION_SIDE_EFFECTS,
  RUN_ORCHESTRATION_VERSION,
} from '../../mcp/v3/run-orchestration.mjs';
import {
  PREFLIGHT_MAX_CHILDREN,
  PREFLIGHT_MIN_CHILDREN,
  RUN_PREFLIGHT_CHECKS,
  RUN_PREFLIGHT_SCHEMA_ID,
  RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS,
  RUN_PREFLIGHT_VERSION,
} from '../../mcp/v3/run-preflight.mjs';

export const RUN_ID = 'run-api-boundary-01';
export const ASSIGNMENT_ID = 'lane-alpha';
export const ASSIGNMENT_ID_B = 'lane-beta';
export const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
export const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
export const DIGEST = 'ab'.repeat(32);
export const LANE_IDENTITY = 'cd'.repeat(16);
export const LANE_IDENTITY_B = 'ef'.repeat(16);
export const PROVIDER = 'grok';
export const MODEL = 'grok-4';
export const HOSTILE_PATH = '/tmp/secret-repo-do-not-leak';
export const HOSTILE_URL = 'https://evil.example/steal?token=secret';
export const HOSTILE_GIT = 'git@github.com:evil/repo.git';
export const HOSTILE_SECRET = 'sk-secret-value-do-not-leak';
export const HOSTILE_TOKEN = 'ghp_hostiletokendoNotLeak001';
export const HOSTILE_ENV = 'GH_TOKEN=ghp_hostiletokendoNotLeak001';
export const CONTENT_FREE = /^[A-Za-z0-9_=.:/\[\]()";', -]+$/u;

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

function falseMap(keys) {
  const values = {};
  for (const key of keys) values[key] = false;
  return values;
}

export function auditSideEffects() {
  return falseMap(PROTECTED_REF_AUDIT_SIDE_EFFECT_NONCLAIMS);
}

export function orchestrationSideEffects(overrides = {}) {
  return { ...falseMap(RUN_ORCHESTRATION_SIDE_EFFECTS), ...overrides };
}

export function preflightSideEffects() {
  return falseMap(RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS);
}

export function validIdentity(overrides = {}) {
  return {
    run_id: RUN_ID,
    base_sha: BASE_SHA,
    assignment_id: ASSIGNMENT_ID,
    provider: PROVIDER,
    ...overrides,
  };
}

export function validFact(overrides = {}) {
  return {
    fact_id: 'protected-ref-audit',
    fact_kind: 'git_identity',
    status: 'verified',
    code: 'host_observed',
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    sequence: 0,
    subject: 'protected-refs',
    authority: 'platform_git',
    method: 'protected_ref_snapshot_compare',
    input_digest: DIGEST,
    output_digest: DIGEST,
    exit_code: 0,
    duration_ms: 1,
    truncated: false,
    payload: { base_sha: BASE_SHA, head_sha: HEAD_SHA },
    payload_digest: DIGEST,
    artifact_digests: [],
    ...overrides,
  };
}

export function validDiscrepancy(overrides = {}) {
  return {
    discrepancy_id: 'protected-ref-audit',
    discrepancy_kind: 'security',
    status: 'recorded',
    code: 'security_boundary',
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    sequence: 0,
    claim_ids: [],
    fact_ids: ['protected-ref-audit'],
    artifact_digests: [],
    ...overrides,
  };
}

export function validComparison(overrides = {}) {
  return {
    outcome: 'match',
    storage: 'loose',
    ref_class: 'user_protected',
    protected: true,
    default_branch_target: true,
    ...overrides,
  };
}

export function validFinding(overrides = {}) {
  return {
    code: 'moved_ref',
    storage: 'loose',
    ref_class: 'user_protected',
    protected: true,
    default_branch_target: true,
    ...overrides,
  };
}

export function validAudit(overrides = {}) {
  const comparisons = overrides.comparisons ?? [validComparison()];
  const receipt = {
    schema: PROTECTED_REF_AUDIT_SCHEMA_ID,
    version: PROTECTED_REF_AUDIT_VERSION,
    status: 'verified',
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    base_sha: BASE_SHA,
    repository_kind: 'local',
    comparisons,
    findings: [],
    observed_classes: [],
    facts: [validFact()],
    discrepancies: [],
    side_effects: auditSideEffects(),
    observation: {
      command_count: 2,
      compared_count: comparisons.length,
      duration_ms: 1,
      loose_count: 1,
      missing_count: 0,
      packed_count: 0,
      symbolic_count: 0,
    },
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'observation') && Object.hasOwn(overrides, 'comparisons')) {
    receipt.observation = {
      ...receipt.observation,
      compared_count: receipt.comparisons.length,
    };
  }
  return receipt;
}

export function verifiedDriftAudit(outcome = 'moved_ref', overrides = {}) {
  const storage = outcome === 'missing_ref'
    ? 'absent'
    : outcome === 'symbolic_ref'
      ? 'symbolic'
      : 'loose';
  return validAudit({
    comparisons: [validComparison({ outcome, storage })],
    observation: {
      command_count: 2,
      compared_count: 1,
      duration_ms: 1,
      loose_count: storage === 'loose' ? 1 : 0,
      missing_count: storage === 'absent' ? 1 : 0,
      packed_count: 0,
      symbolic_count: storage === 'symbolic' ? 1 : 0,
    },
    ...overrides,
  });
}

export function failedAudit(code = 'moved_ref', overrides = {}) {
  const finding = validFinding({ code, ...(code === 'missing_ref' ? { storage: 'absent' } : {}) });
  return validAudit({
    status: 'failed',
    comparisons: [validComparison({
      outcome: code === 'hostile_ref' ? 'moved_ref' : code,
      storage: finding.storage,
    })],
    findings: [finding],
    observed_classes: [finding.code],
    facts: [validFact({ status: 'failed', exit_code: 1 })],
    discrepancies: [validDiscrepancy()],
    observation: {
      command_count: 2,
      compared_count: 1,
      duration_ms: 1,
      loose_count: code === 'missing_ref' ? 0 : 1,
      missing_count: code === 'missing_ref' ? 1 : 0,
      packed_count: 0,
      symbolic_count: 0,
    },
    ...overrides,
  });
}

export function validGitIdentity(overrides = {}) {
  return {
    schema: GIT_IDENTITY_SCHEMA_ID,
    repository_path: HOSTILE_PATH,
    base_sha: BASE_SHA,
    digest: DIGEST,
    ...overrides,
  };
}

export function validPreflight(overrides = {}) {
  const { assignment_ids: assignmentIdsOverride, ...rest } = overrides;
  const assignmentIds = [...(assignmentIdsOverride ?? [ASSIGNMENT_ID])];
  const children = {
    count: assignmentIds.length,
    minimum: PREFLIGHT_MIN_CHILDREN,
    maximum: PREFLIGHT_MAX_CHILDREN,
    independent: true,
    concurrency: assignmentIds.length,
    assignment_ids: assignmentIds,
    scope_pair_checks: 0,
  };
  return {
    schema: RUN_PREFLIGHT_SCHEMA_ID,
    version: RUN_PREFLIGHT_VERSION,
    status: 'ready',
    run_id: RUN_ID,
    children,
    capacity: {
      source: 'injected',
      cpu_parallelism: 8,
      total_ram_bytes: 8_589_934_592,
      available_ram_bytes: 8_589_934_592,
      required_ram_bytes: 268_435_456 * assignmentIds.length,
      cpu_ok: true,
      ram_ok: true,
    },
    repository: {
      path: HOSTILE_PATH,
      base_sha: BASE_SHA,
      object_type: 'commit',
      git_dir: `${HOSTILE_PATH}/.git`,
    },
    checks: [...RUN_PREFLIGHT_CHECKS],
    side_effects: preflightSideEffects(),
    git_identity: validGitIdentity(),
    ...rest,
  };
}

export function validLane(overrides = {}) {
  return {
    assignment_id: ASSIGNMENT_ID,
    provider: PROVIDER,
    model: MODEL,
    status: 'projected',
    identity: LANE_IDENTITY,
    projected_keys: ['GIT_TERMINAL_PROMPT', 'XAI_API_KEY'],
    credential_present: true,
    ...overrides,
  };
}

export function validOrchestration(overrides = {}) {
  const lanes = overrides.lanes ?? [validLane()];
  const assignmentIds = lanes.map((lane) => lane.assignment_id);
  const preflight = overrides.preflight ?? validPreflight({ assignment_ids: assignmentIds });
  const receipt = {
    schema: RUN_ORCHESTRATION_SCHEMA_ID,
    version: RUN_ORCHESTRATION_VERSION,
    status: 'prepared',
    run_id: RUN_ID,
    intent: 'prepare',
    preflight,
    lanes,
    checks: [...RUN_ORCHESTRATION_CHECKS],
    side_effects: orchestrationSideEffects({ credentials_projected: true }),
    ...overrides,
  };
  if (overrides.preflight === undefined && overrides.lanes !== undefined) {
    receipt.preflight = validPreflight({ assignment_ids: assignmentIds });
  }
  return receipt;
}

export function dispatchedOrchestration(overrides = {}) {
  return validOrchestration({
    status: 'dispatched',
    intent: 'dispatch',
    side_effects: orchestrationSideEffects({
      credentials_projected: true,
      credential_handoff_created: true,
      task_dispatched: true,
      provider_process_started: true,
    }),
    ...overrides,
  });
}

export function orchestrationDenial(code = 'host_cpu_capacity_exceeded', overrides = {}) {
  return {
    schema: RUN_PREFLIGHT_SCHEMA_ID,
    version: RUN_PREFLIGHT_VERSION,
    code,
    run_id: RUN_ID,
    ...overrides,
  };
}

export function validLifecycle(overrides = {}) {
  return {
    status: 'terminal',
    cleaned: true,
    missing: false,
    unresolved: [],
    ...overrides,
  };
}

export function unresolvedLifecycle(overrides = {}) {
  return validLifecycle({
    status: 'cancelled',
    cleaned: false,
    unresolved: [{ assignment_id: ASSIGNMENT_ID, code: 'handoff_cleanup_failed' }],
    ...overrides,
  });
}

export function validInput(overrides = {}) {
  const input = {
    schema: RUN_API_BOUNDARY_SCHEMA_ID,
    version: RUN_API_BOUNDARY_VERSION,
    identity: validIdentity(),
    audit: validAudit(),
    orchestration: validOrchestration(),
    ...overrides,
  };
  if (overrides.identity) input.identity = { ...validIdentity(), ...overrides.identity };
  if (overrides.audit) input.audit = overrides.audit;
  if (overrides.orchestration) input.orchestration = overrides.orchestration;
  if (Object.hasOwn(overrides, 'lifecycle')) input.lifecycle = overrides.lifecycle;
  return input;
}

export {
  PROTECTED_REF_AUDIT_CHECKS,
  RUN_ORCHESTRATION_CHECKS,
  RUN_PREFLIGHT_CHECKS,
};
