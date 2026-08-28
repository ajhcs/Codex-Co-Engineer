// WorktreeCleanupAdapterV1 — R1-340 supported adapter over the pure
// proof-bound worktree cleanup planner (ADR 0001 identifiers
// `manual_proof_bound_cleanup`, `no_automatic_gc`, `exact_identities`,
// `gate_a_safe_per_run_cleanup`, `gate_a_no_protected_ref_mutation`).
//
// Additive v3 adapter. Filesystem and Git operations are injected; this
// module has no default worktree/ref deletion and never shells out to
// `git` or `worktree-bootstrap`. Tests must inject fakes that do not
// delete real worktrees or refs. Production callers inject their own
// exact, identity-bound operations.
//
// planCleanup observes topology once and returns the planner dry-run.
// executeCleanup observes, plans, then immediately rereads worktree,
// lock, and ref topology before any mutation. A changed digest refuses
// the stale plan. Before every mutation it reobserves and CAS-binds the
// exact task/lock/repository/worktree/ref/head/tree/topology digest so
// no actor can reacquire or reuse the target between operations. The
// ownership lock stays held until worktree, ref, and owned-artifact
// destruction finish; clean_lock is last. Unknown task/lock/ownership
// and bare repositories fail closed with no remove_worktree or
// delete_ref_cas. Ref deletion is the planner's expected-SHA CAS
// operation only. Partial mutation is reported honestly: cleaned is
// false whenever remaining work exists, and removed/remaining/unresolved
// stay in plan order. If live topology observation or revalidation fails
// after injected mutations, executeCleanup halts without further
// mutations and returns that partial receipt instead of throwing away
// applied state. Observer failure before any mutation returns a bounded
// failed receipt with the lock still held. Age, dependency graphs, and
// global GC are not consulted.

import { types as utilTypes } from 'node:util';

import {
  capturedFreeze,
  capturedIncludes,
  capturedOwnKeys,
} from './grammar.mjs';
import {
  RunContractV1Error,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  ownDataValue,
} from './selection-json.mjs';
import {
  PLAN_ACTIONS,
  WORKTREE_CLEANUP_ERROR_CODES,
  WORKTREE_CLEANUP_PLANNER_SCHEMA_ID,
  WORKTREE_CLEANUP_PLANNER_VERSION,
  WORKTREE_CLEANUP_STATUS_SCHEMA_ID,
  bindWorktreeCleanupProofV1,
  cleanupBindDigestV1,
  planWorktreeCleanupV1,
  topologyDigestV1,
} from './worktree-cleanup-planner.mjs';

export const WORKTREE_CLEANUP_ADAPTER_SCHEMA_ID =
  'codex-co-engineer.worktree-cleanup-adapter.v1';
export const WORKTREE_CLEANUP_ADAPTER_VERSION = 1;
export const WORKTREE_CLEANUP_ADAPTER_RECEIPT_SCHEMA_ID =
  'codex-co-engineer.worktree-cleanup-adapter-receipt.v1';

export const WORKTREE_CLEANUP_ADAPTER_METHODS = capturedFreeze([
  'planCleanup', 'executeCleanup',
]);
export const ADAPTER_FACTORY_KEYS = capturedFreeze([
  'observeTopology',
  'cleanLock',
  'removeWorktree',
  'deleteRefCas',
  'removeOwnedArtifact',
]);
export const ADAPTER_REQUIRED_FACTORY_KEYS = capturedFreeze(['observeTopology']);
export const ADAPTER_MUTATOR_KEYS = capturedFreeze([
  'cleanLock', 'removeWorktree', 'deleteRefCas', 'removeOwnedArtifact',
]);
export const ADAPTER_MODES = capturedFreeze(['dry_run', 'execute']);
export const ADAPTER_STATUSES = capturedFreeze([
  'plan_ready', 'refused', 'cleaned', 'partial', 'dry_run',
]);
export const ADAPTER_PHASES = capturedFreeze([
  'bound', 'topology_observed', 'plan_ready', 'refused',
  'topology_reread', 'dry_run', 'executing', 'cleaned', 'partial',
]);

export const WORKTREE_CLEANUP_ADAPTER_CHECKS = capturedFreeze([
  'injected_observe',
  'dry_run_plan',
  'topology_reread_before_cleanup',
  'stale_plan_refused',
  'cas_bind_before_each_mutation',
  'lock_held_until_complete',
  'ref_cas_only',
  'no_default_git_mutation',
  'no_automatic_gc',
  'partial_cleanup_truthful',
]);

export const WORKTREE_CLEANUP_ADAPTER_ERROR_CODES = capturedFreeze([
  'accessor_property_denied',
  'aliased_reference_denied',
  'exotic_prototype_denied',
  'invalid_format',
  'invalid_type',
  'missing_key',
  'non_enumerable_property_denied',
  'out_of_range',
  'own_undefined_denied',
  'proxy_denied',
  'symbol_key_denied',
  'unknown_key',
  'value_depth_exceeded',
  'cleanup_observer_required',
  'cleanup_executor_required',
  'cleanup_observer_failed',
  'topology_changed',
  'cleanup_mutation_failed',
]);

export const ADAPTER_SIDE_EFFECTS = capturedFreeze([
  'lock_cleaned',
  'worktree_removed',
  'ref_deleted',
  'artifacts_removed',
  'remote_mutated',
  'protected_ref_mutated',
  'automatic_gc',
  'real_git_default',
  'dependency_graph',
]);

export const ADAPTER_ALWAYS_FALSE_SIDE_EFFECTS = capturedFreeze([
  'remote_mutated',
  'protected_ref_mutated',
  'automatic_gc',
  'real_git_default',
  'dependency_graph',
]);

const ADAPTER_REQUEST_KEYS = capturedFreeze(['proof']);
const MUTATOR_BY_ACTION = capturedFreeze({
  clean_lock: 'cleanLock',
  remove_worktree: 'removeWorktree',
  delete_ref_cas: 'deleteRefCas',
  remove_owned_artifact: 'removeOwnedArtifact',
});

const MSG = capturedFreeze({
  accessor_property_denied: 'Worktree cleanup adapter denies accessor inputs.',
  aliased_reference_denied: 'Worktree cleanup adapter denies aliased inputs.',
  exotic_prototype_denied: 'Worktree cleanup adapter denies exotic prototypes.',
  invalid_format: 'Worktree cleanup adapter rejected a value that violates a closed grammar.',
  invalid_type: 'Worktree cleanup adapter rejected a non-JSON value.',
  missing_key: 'Worktree cleanup adapter requires every canonical key.',
  non_enumerable_property_denied: 'Worktree cleanup adapter denies non-enumerable properties.',
  out_of_range: 'Worktree cleanup adapter rejected a value outside closed bounds.',
  own_undefined_denied: 'Worktree cleanup adapter denies own undefined values.',
  proxy_denied: 'Worktree cleanup adapter denies Proxy inputs.',
  symbol_key_denied: 'Worktree cleanup adapter denies symbol keys.',
  unknown_key: 'Worktree cleanup adapter rejects keys outside the closed vocabulary.',
  value_depth_exceeded: 'Worktree cleanup adapter rejected nested input that exceeds closed depth.',
  cleanup_observer_required: 'Worktree cleanup requires an injected topology observer.',
  cleanup_executor_required: 'Worktree cleanup execute requires injected mutation operations.',
  cleanup_observer_failed: 'Worktree cleanup topology observation failed closed.',
  topology_changed: 'Worktree cleanup refused a topology that changed after plan.',
  cleanup_mutation_failed: 'Worktree cleanup mutation failed closed.',
});

const IS_PROXY = utilTypes.isProxy;
const OWN_KEYS = capturedOwnKeys;
const SET_CTOR = Set;

function deny(code, path) {
  fail(code, path, MSG[code] ?? MSG.invalid_format);
}

function publicCode(error) {
  if (error instanceof RunContractV1Error) {
    if (capturedIncludes(WORKTREE_CLEANUP_ADAPTER_ERROR_CODES, error.code)
      || capturedIncludes(WORKTREE_CLEANUP_ERROR_CODES, error.code)) {
      return error.code;
    }
  }
  return 'invalid_type';
}

function observerFailureCode(error) {
  if (error instanceof RunContractV1Error) {
    if (error.code === 'cleanup_observer_failed'
      || capturedIncludes(WORKTREE_CLEANUP_ADAPTER_ERROR_CODES, error.code)
      || capturedIncludes(WORKTREE_CLEANUP_ERROR_CODES, error.code)) {
      return error.code;
    }
  }
  return 'cleanup_observer_failed';
}

function remap(error, path) {
  deny(publicCode(error), path);
}

function assertClosedKeySet(input, allowed, path, { json = true } = {}) {
  if (input === undefined || input === null) deny('invalid_type', path);
  if (typeof input === 'object' || typeof input === 'function') {
    try { assertNotProxy(input, path); } catch (error) { remap(error, path); }
  }
  if (typeof input !== 'object') deny('invalid_type', path);
  try {
    assertPlainObject(input, 'invalid_type', path, path);
  } catch (error) { remap(error, path); }
  let keys;
  try { keys = OWN_KEYS(input); } catch { deny('invalid_type', path); }
  const allowedSet = new SET_CTOR(allowed);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key === 'symbol') deny('symbol_key_denied', path);
    if (typeof key !== 'string') deny('invalid_format', path);
    if (!allowedSet.has(key)) deny('unknown_key', `${path}.${key}`);
  }
  if (json) {
    try {
      assertDirectJsonClosure(input, path);
    } catch (error) { remap(error, path); }
  }
  return input;
}

function assertClosedObject(input, allowed, path) {
  return assertClosedKeySet(input, allowed, path, { json: true });
}

function assertFactoryOptions(input, allowed, path) {
  return assertClosedKeySet(input, allowed, path, { json: false });
}

function assertFunction(value, path) {
  if (typeof value !== 'function' || IS_PROXY(value)) deny('invalid_type', path);
  return value;
}

function emptySideEffects() {
  const effects = {};
  for (let i = 0; i < ADAPTER_SIDE_EFFECTS.length; i += 1) {
    effects[ADAPTER_SIDE_EFFECTS[i]] = false;
  }
  return effects;
}

function emptyAdapterChecks() {
  const checks = {};
  for (let i = 0; i < WORKTREE_CLEANUP_ADAPTER_CHECKS.length; i += 1) {
    checks[WORKTREE_CLEANUP_ADAPTER_CHECKS[i]] = false;
  }
  checks.no_default_git_mutation = true;
  checks.no_automatic_gc = true;
  checks.ref_cas_only = true;
  checks.partial_cleanup_truthful = true;
  return checks;
}

function pushStatus(statuses, phase, verdict, code) {
  statuses.push({
    schema: WORKTREE_CLEANUP_STATUS_SCHEMA_ID,
    sequence: statuses.length + 1,
    phase,
    verdict,
    code,
  });
}

function remainingFrom(operations) {
  const remaining = [];
  for (let i = 0; i < operations.length; i += 1) {
    const operation = operations[i];
    if (operation.action !== 'reread_topology') remaining.push(opLabel(operation));
  }
  return remaining;
}

function opLabel(operation) {
  if (operation.action === 'remove_owned_artifact') {
    return `${operation.action}:${operation.relative_path}`;
  }
  if (operation.action === 'delete_ref_cas') {
    return `${operation.action}:${operation.ref}`;
  }
  if (operation.action === 'clean_lock') {
    return `${operation.action}:${operation.lock_id}`;
  }
  return operation.action;
}

function receipt(fields) {
  return freezeData({
    schema: WORKTREE_CLEANUP_ADAPTER_RECEIPT_SCHEMA_ID,
    version: WORKTREE_CLEANUP_ADAPTER_VERSION,
    planner_schema: WORKTREE_CLEANUP_PLANNER_SCHEMA_ID,
    planner_version: WORKTREE_CLEANUP_PLANNER_VERSION,
    mode: fields.mode,
    status: fields.status,
    verdict: fields.verdict,
    code: fields.code,
    cleaned: fields.cleaned,
    proof_bound: true,
    automatic_gc: false,
    age_authority: false,
    dry_run: fields.mode === 'dry_run',
    topology_digest: fields.topology_digest,
    bind_digest: fields.bind_digest ?? null,
    reread_digest: fields.reread_digest ?? null,
    reread_bind_digest: fields.reread_bind_digest ?? null,
    bound: fields.bound,
    plan: fields.plan,
    checks: fields.checks,
    adapter_checks: fields.adapter_checks,
    statuses: fields.statuses,
    removed: fields.removed,
    remaining: fields.remaining,
    unresolved: fields.unresolved,
    side_effects: fields.side_effects,
  });
}

async function callObserver(observeTopology, bound, path) {
  let snapshot;
  try {
    snapshot = await observeTopology(bound);
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    deny('cleanup_observer_failed', path);
  }
  return snapshot;
}

function parseRequest(input) {
  const object = assertClosedObject(input, ADAPTER_REQUEST_KEYS, 'request');
  if (!hasOwn(object, 'proof')) deny('missing_key', 'request.proof');
  const proof = bindWorktreeCleanupProofV1(ownDataValue(object, 'proof', 'request.proof'));
  return { proof };
}

function requireMutators(injected) {
  for (let i = 0; i < ADAPTER_MUTATOR_KEYS.length; i += 1) {
    const key = ADAPTER_MUTATOR_KEYS[i];
    if (typeof injected[key] !== 'function') deny('cleanup_executor_required', `operations.${key}`);
  }
}

function mutationApplied(result) {
  return result !== null && typeof result === 'object' && result.applied === true
    && result.remaining === false;
}

function remainingHasOpenDestruction(remaining, currentLabel) {
  for (let i = 0; i < remaining.length; i += 1) {
    const item = remaining[i];
    if (item === currentLabel) continue;
    if (item === 'remove_worktree' || item.startsWith('delete_ref_cas:')) return true;
  }
  return false;
}

function liveMutationBind(proof, planned, operation, liveTopology) {
  const livePlan = planWorktreeCleanupV1({ proof, topology: liveTopology });
  const liveBindDigest = livePlan.bind_digest;
  if (livePlan.verdict !== 'allow') {
    return { ok: false, code: livePlan.code, bind_digest: liveBindDigest };
  }
  if (liveBindDigest !== planned.bind_digest) {
    return { ok: false, code: 'topology_changed', bind_digest: liveBindDigest };
  }
  if (operation.action !== 'clean_lock'
    && liveTopology.lock_state !== 'abandoned'
    && planned.plan.operations.some((entry) => entry.action === 'clean_lock')) {
    return { ok: false, code: 'unknown_ownership', bind_digest: liveBindDigest };
  }
  return { ok: true, code: null, bind_digest: liveBindDigest };
}

export function describeWorktreeCleanupAdapterV1() {
  return freezeData({
    schema: WORKTREE_CLEANUP_ADAPTER_SCHEMA_ID,
    version: WORKTREE_CLEANUP_ADAPTER_VERSION,
    rule: 'injected_ops_cas_bind_lock_held_until_complete',
    methods: [...WORKTREE_CLEANUP_ADAPTER_METHODS],
    factory_keys: [...ADAPTER_FACTORY_KEYS],
    required_factory_keys: [...ADAPTER_REQUIRED_FACTORY_KEYS],
    mutator_keys: [...ADAPTER_MUTATOR_KEYS],
    modes: [...ADAPTER_MODES],
    checks: [...WORKTREE_CLEANUP_ADAPTER_CHECKS],
    error_codes: [...WORKTREE_CLEANUP_ADAPTER_ERROR_CODES],
    side_effects: [...ADAPTER_SIDE_EFFECTS],
    always_false_side_effects: [...ADAPTER_ALWAYS_FALSE_SIDE_EFFECTS],
    plan_actions: [...PLAN_ACTIONS],
    composed_surfaces: capturedFreeze({
      planner: WORKTREE_CLEANUP_PLANNER_SCHEMA_ID,
      filesystem: 'injected only; no default',
      git: 'injected only; no default',
      automatic_gc: 'forbidden',
      gate_a: 'not claimed',
      mcp: 'not wired',
    }),
  });
}

export function createWorktreeCleanupAdapterV1(options) {
  const object = assertFactoryOptions(options, ADAPTER_FACTORY_KEYS, 'options');
  if (!hasOwn(object, 'observeTopology')) deny('cleanup_observer_required', 'options.observeTopology');
  const observeTopology = assertFunction(
    ownDataValue(object, 'observeTopology', 'options.observeTopology'),
    'options.observeTopology',
  );
  const injected = { observeTopology };
  for (let i = 0; i < ADAPTER_MUTATOR_KEYS.length; i += 1) {
    const key = ADAPTER_MUTATOR_KEYS[i];
    if (hasOwn(object, key)) {
      injected[key] = assertFunction(ownDataValue(object, key, `options.${key}`), `options.${key}`);
    }
  }

  async function planFrom(proof) {
    const topology = await callObserver(observeTopology, proof, 'observeTopology');
    return planWorktreeCleanupV1({ proof, topology });
  }

  async function planCleanup(input) {
    const { proof } = parseRequest(input);
    const planned = await planFrom(proof);
    const adapterChecks = emptyAdapterChecks();
    adapterChecks.injected_observe = true;
    adapterChecks.dry_run_plan = true;
    adapterChecks.lock_held_until_complete = planned.plan.lock_held_until_complete === true;
    const statuses = [...planned.statuses];
    pushStatus(
      statuses,
      planned.verdict === 'allow' ? 'dry_run' : 'refused',
      planned.verdict,
      planned.code,
    );
    const sideEffects = emptySideEffects();
    return receipt({
      mode: 'dry_run',
      status: planned.verdict === 'allow' ? 'dry_run' : 'refused',
      verdict: planned.verdict,
      code: planned.code,
      cleaned: false,
      topology_digest: planned.topology_digest,
      bind_digest: planned.bind_digest,
      bound: planned.bound,
      plan: planned.plan,
      checks: planned.checks,
      adapter_checks: adapterChecks,
      statuses,
      removed: [],
      remaining: planned.verdict === 'allow' ? remainingFrom(planned.plan.operations) : [],
      unresolved: planned.verdict === 'allow' ? [] : [{ action: 'plan', code: planned.code }],
      side_effects: sideEffects,
    });
  }

  async function executeCleanup(input) {
    const { proof } = parseRequest(input);
    requireMutators(injected);
    const adapterChecks = emptyAdapterChecks();
    adapterChecks.injected_observe = true;
    const planned = await planFrom(proof);
    adapterChecks.lock_held_until_complete = planned.plan.lock_held_until_complete === true;
    if (planned.verdict !== 'allow') {
      const statuses = [...planned.statuses];
      pushStatus(statuses, 'refused', 'deny', planned.code);
      return receipt({
        mode: 'execute',
        status: 'refused',
        verdict: 'deny',
        code: planned.code,
        cleaned: false,
        topology_digest: planned.topology_digest,
        bind_digest: planned.bind_digest,
        bound: planned.bound,
        plan: planned.plan,
        checks: planned.checks,
        adapter_checks: adapterChecks,
        statuses,
        removed: [],
        remaining: [],
        unresolved: [{ action: 'plan', code: planned.code }],
        side_effects: emptySideEffects(),
      });
    }

    const statuses = [...planned.statuses];
    let rereadTopology;
    let rereadDigest;
    let rereadBindDigest;
    try {
      rereadTopology = await callObserver(observeTopology, proof, 'observeTopology.reread');
      rereadDigest = topologyDigestV1(rereadTopology);
      rereadBindDigest = cleanupBindDigestV1(planned.bound, rereadTopology);
    } catch (error) {
      const code = observerFailureCode(error);
      adapterChecks.topology_reread_before_cleanup = true;
      pushStatus(statuses, 'topology_reread', 'deny', code);
      pushStatus(statuses, 'refused', 'deny', code);
      return receipt({
        mode: 'execute',
        status: 'refused',
        verdict: 'deny',
        code,
        cleaned: false,
        topology_digest: planned.topology_digest,
        bind_digest: planned.bind_digest,
        bound: planned.bound,
        plan: planned.plan,
        checks: planned.checks,
        adapter_checks: adapterChecks,
        statuses,
        removed: [],
        remaining: remainingFrom(planned.plan.operations),
        unresolved: [{ action: 'reread_topology', code }],
        side_effects: emptySideEffects(),
      });
    }
    adapterChecks.topology_reread_before_cleanup = true;
    pushStatus(statuses, 'topology_reread', 'pending', null);

    if (rereadDigest !== planned.topology_digest || rereadBindDigest !== planned.bind_digest) {
      adapterChecks.stale_plan_refused = true;
      const rereadPlan = planWorktreeCleanupV1({ proof, topology: rereadTopology });
      const code = rereadPlan.verdict === 'deny' ? rereadPlan.code : 'topology_changed';
      const checks = rereadPlan.verdict === 'deny' ? rereadPlan.checks : planned.checks;
      pushStatus(statuses, 'refused', 'deny', code);
      return receipt({
        mode: 'execute',
        status: 'refused',
        verdict: 'deny',
        code,
        cleaned: false,
        topology_digest: planned.topology_digest,
        bind_digest: planned.bind_digest,
        reread_digest: rereadDigest,
        reread_bind_digest: rereadBindDigest,
        bound: planned.bound,
        plan: planned.plan,
        checks,
        adapter_checks: adapterChecks,
        statuses,
        removed: [],
        remaining: remainingFrom(planned.plan.operations),
        unresolved: [{ action: 'reread_topology', code }],
        side_effects: emptySideEffects(),
      });
    }
    adapterChecks.stale_plan_refused = true;
    adapterChecks.cas_bind_before_each_mutation = true;

    pushStatus(statuses, 'executing', 'allow', null);
    const sideEffects = emptySideEffects();
    const removed = [];
    const remaining = remainingFrom(planned.plan.operations);
    const unresolved = [];
    let halted = false;
    let haltCode = null;

    for (let i = 0; i < planned.plan.operations.length; i += 1) {
      const operation = planned.plan.operations[i];
      if (operation.action === 'reread_topology') continue;
      const label = opLabel(operation);
      if (halted) {
        unresolved.push({ action: operation.action, code: 'cleanup_mutation_failed' });
        continue;
      }
      if (operation.action === 'clean_lock' && remainingHasOpenDestruction(remaining, label)) {
        unresolved.push({ action: operation.action, code: 'cleanup_mutation_failed' });
        halted = true;
        haltCode = 'cleanup_mutation_failed';
        continue;
      }
      let liveTopology;
      let bindResult;
      try {
        liveTopology = await callObserver(observeTopology, proof, 'observeTopology.bind');
        bindResult = liveMutationBind(proof, planned, operation, liveTopology);
      } catch (error) {
        const code = observerFailureCode(error);
        unresolved.push({ action: operation.action, code });
        halted = true;
        haltCode = code;
        continue;
      }
      if (bindResult.ok !== true) {
        unresolved.push({ action: operation.action, code: bindResult.code });
        halted = true;
        haltCode = 'cleanup_mutation_failed';
        continue;
      }
      const mutatorKey = MUTATOR_BY_ACTION[operation.action];
      let result;
      try {
        result = await injected[mutatorKey](operation);
      } catch (error) {
        if (error instanceof RunContractV1Error) {
          unresolved.push({ action: operation.action, code: error.code });
          haltCode = 'cleanup_mutation_failed';
        } else {
          unresolved.push({ action: operation.action, code: 'cleanup_mutation_failed' });
          haltCode = 'cleanup_mutation_failed';
        }
        halted = true;
        continue;
      }
      if (!mutationApplied(result)) {
        const code = typeof result?.code === 'string' ? result.code : 'cleanup_mutation_failed';
        unresolved.push({ action: operation.action, code });
        halted = true;
        haltCode = 'cleanup_mutation_failed';
        continue;
      }
      removed.push(label);
      const index = remaining.indexOf(label);
      if (index !== -1) remaining.splice(index, 1);
      if (operation.action === 'clean_lock') sideEffects.lock_cleaned = true;
      if (operation.action === 'remove_worktree') sideEffects.worktree_removed = true;
      if (operation.action === 'delete_ref_cas') sideEffects.ref_deleted = true;
      if (operation.action === 'remove_owned_artifact') sideEffects.artifacts_removed = true;
    }

    const cleaned = halted === false && remaining.length === 0 && unresolved.length === 0;
    const status = cleaned ? 'cleaned' : 'partial';
    const code = cleaned ? null : (haltCode ?? 'cleanup_mutation_failed');
    pushStatus(statuses, status, cleaned ? 'allow' : 'deny', code);
    return receipt({
      mode: 'execute',
      status,
      verdict: cleaned ? 'allow' : 'deny',
      code,
      cleaned,
      topology_digest: planned.topology_digest,
      bind_digest: planned.bind_digest,
      reread_digest: rereadDigest,
      reread_bind_digest: rereadBindDigest,
      bound: planned.bound,
      plan: planned.plan,
      checks: planned.checks,
      adapter_checks: adapterChecks,
      statuses,
      removed,
      remaining,
      unresolved,
      side_effects: sideEffects,
    });
  }

  return freezeData({
    planCleanup,
    executeCleanup,
  });
}

capturedFreeze(describeWorktreeCleanupAdapterV1);
capturedFreeze(createWorktreeCleanupAdapterV1);
