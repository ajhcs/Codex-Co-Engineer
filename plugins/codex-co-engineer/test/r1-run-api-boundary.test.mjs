// P32 run API boundary — focused coverage: paired P30/P31 success projection,
// deterministic frozen JSON, negative evidence preservation, identity binding,
// detachment, and concurrent pure projection. This suite never executes P30
// audit or P31 orchestration lifecycles.

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import { PROTECTED_REF_AUDIT_SCHEMA_ID } from '../mcp/v3/protected-ref-audit.mjs';
import {
  RUN_API_BOUNDARY_CHECKS,
  RUN_API_BOUNDARY_SCHEMA_ID,
  RUN_API_BOUNDARY_SIDE_EFFECT_NONCLAIMS,
  RUN_API_BOUNDARY_VERSION,
  describeRunApiBoundaryV1,
  projectRunApiBoundaryV1,
} from '../mcp/v3/run-api-boundary.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { RUN_ORCHESTRATION_SCHEMA_ID } from '../mcp/v3/run-orchestration.mjs';
import { RUN_PREFLIGHT_SCHEMA_ID } from '../mcp/v3/run-preflight.mjs';
import {
  ASSIGNMENT_ID,
  ASSIGNMENT_ID_B,
  BASE_SHA,
  CONTENT_FREE,
  HOSTILE_GIT,
  HOSTILE_PATH,
  HOSTILE_SECRET,
  HOSTILE_TOKEN,
  HOSTILE_URL,
  LANE_IDENTITY_B,
  MODEL,
  PROVIDER,
  RUN_ID,
  dispatchedOrchestration,
  failedAudit,
  orchestrationDenial,
  unresolvedLifecycle,
  validAudit,
  validInput,
  validLane,
  validLifecycle,
  validOrchestration,
  verifiedDriftAudit,
} from './fixtures/r1-run-api-boundary-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function assertContentFree(value, extras = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes('/tmp'), false, 'must not leak repository paths');
  assert.equal(text.includes('https://'), false, 'must not leak URLs');
  assert.equal(text.includes('git@'), false, 'must not leak hosting URLs');
  assert.equal(text.includes(HOSTILE_PATH), false);
  assert.equal(text.includes(HOSTILE_URL), false);
  assert.equal(text.includes(HOSTILE_GIT), false);
  assert.equal(text.includes(HOSTILE_SECRET), false);
  assert.equal(text.includes(HOSTILE_TOKEN), false);
  for (const extra of extras) {
    assert.equal(text.includes(extra), false, `must not echo ${extra}`);
  }
  const message = typeof value === 'string' ? value : value?.message;
  if (typeof message === 'string') assert.match(message, CONTENT_FREE);
}

function assertAdapterNonclaims(result) {
  for (const key of RUN_API_BOUNDARY_SIDE_EFFECT_NONCLAIMS) {
    assert.equal(result.side_effects[key], false, key);
  }
  assert.equal(result.invariants.read_only_audit, true);
  assert.equal(result.invariants.credentials_not_projected, true);
  assert.equal(result.invariants.refs_not_mutated, true);
  assert.equal(result.invariants.workspace_not_created, true);
  assert.equal(result.invariants.reservation_not_held, true);
  assert.equal(result.invariants.remote_mutated, false);
  assert.equal(result.invariants.public_api_exposed, false);
  assert.equal(result.invariants.gate_a_claimed, false);
  assert.equal(result.invariants.release_decided, false);
  assert.equal(result.invariants.supervisor_cutover, false);
  assert.equal(result.invariants.cleanup_truthful, true);
}

test('RunApiBoundaryV1 is a closed frozen v1 adapter and not a 4.0.0 major', () => {
  assert.equal(RUN_API_BOUNDARY_SCHEMA_ID, 'codex-co-engineer.run-api-boundary.v1');
  assert.equal(RUN_API_BOUNDARY_VERSION, 1);
  assert.equal(RUN_API_BOUNDARY_SCHEMA_ID.includes('4.0.0'), false);
  const inventory = describeRunApiBoundaryV1();
  const again = describeRunApiBoundaryV1();
  assert.ok(Object.isFrozen(inventory));
  assert.ok(Object.isFrozen(inventory.composed_surfaces));
  assert.equal(inventory.rule, 'pure_projection_of_accepted_p30_p31_receipts');
  assert.equal(inventory.composed_surfaces.protected_ref_audit, PROTECTED_REF_AUDIT_SCHEMA_ID);
  assert.equal(inventory.composed_surfaces.run_orchestration, RUN_ORCHESTRATION_SCHEMA_ID);
  assert.equal(inventory.composed_surfaces.run_preflight, RUN_PREFLIGHT_SCHEMA_ID);
  assert.equal(inventory.composed_surfaces.remote_mutation, 'denied');
  assert.equal(inventory.composed_surfaces.gate_a, 'not claimed');
  assert.equal(inventory.composed_surfaces.audit_lifecycle, 'not invoked; receipts are consumed as values');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(inventory)),
    JSON.parse(JSON.stringify(again)),
  );
  assert.deepEqual([...inventory.checks], [...RUN_API_BOUNDARY_CHECKS]);
});

test('paired P30/P31 success projects a detached ready result with stable JSON', () => {
  const input = validInput();
  const first = projectRunApiBoundaryV1(input);
  const second = projectRunApiBoundaryV1(validInput());
  assert.equal(first.status, 'ready');
  assert.equal(first.schema, RUN_API_BOUNDARY_SCHEMA_ID);
  assert.equal(first.run_id, RUN_ID);
  assert.equal(first.base_sha, BASE_SHA);
  assert.equal(first.assignment_id, ASSIGNMENT_ID);
  assert.equal(first.provider, PROVIDER);
  assert.equal(first.audit.status, 'verified');
  assert.equal(first.audit.schema, PROTECTED_REF_AUDIT_SCHEMA_ID);
  assert.equal(first.audit.comparisons[0].outcome, 'match');
  assert.equal(first.audit.facts[0].method, 'protected_ref_snapshot_compare');
  assert.equal(first.audit.facts[0].authority, 'platform_git');
  assert.equal(first.audit.discrepancies.length, 0);
  assert.equal(first.orchestration.kind, 'receipt');
  assert.equal(first.orchestration.status, 'prepared');
  assert.equal(first.orchestration.preflight_status, 'ready');
  assert.equal(first.orchestration.lanes[0].provider, PROVIDER);
  assert.equal(first.orchestration.lanes[0].model, MODEL);
  assert.equal(first.orchestration.lanes[0].credential_present, true);
  assert.equal(Object.hasOwn(first.orchestration.lanes[0], 'identity'), false);
  assert.equal(Object.hasOwn(first.orchestration.lanes[0], 'projected_keys'), false);
  assert.equal(first.lifecycle, null);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.audit));
  assert.ok(Object.isFrozen(first.orchestration.lanes[0]));
  assertAdapterNonclaims(first);
  assertContentFree(first);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(canonicalJsonStringify(first), canonicalJsonStringify(second));
});

test('dispatched orchestration with a clean lifecycle remains ready', () => {
  const result = projectRunApiBoundaryV1(validInput({
    orchestration: dispatchedOrchestration(),
    lifecycle: validLifecycle(),
  }));
  assert.equal(result.status, 'ready');
  assert.equal(result.orchestration.status, 'dispatched');
  assert.equal(result.orchestration.side_effects.task_dispatched, true);
  assert.equal(result.orchestration.side_effects.workspace_created, false);
  assert.equal(result.lifecycle.cleaned, true);
  assert.equal(result.lifecycle.unresolved.length, 0);
  assertContentFree(result, [HOSTILE_PATH]);
});

test('P30 moved missing and hostile-ref receipts remain failed without side effects', () => {
  for (const code of ['moved_ref', 'missing_ref', 'hostile_ref']) {
    const result = projectRunApiBoundaryV1(validInput({ audit: failedAudit(code) }));
    assert.equal(result.status, 'failed', code);
    assert.equal(result.audit.status, 'failed', code);
    assert.equal(result.audit.findings[0].code, code, code);
    assert.equal(result.audit.facts[0].status, 'failed', code);
    assert.equal(result.audit.discrepancies[0].code, 'security_boundary', code);
    assert.equal(result.orchestration.status, 'prepared', code);
    assertAdapterNonclaims(result);
    assertContentFree(result);
  }
});

test('verified P30 comparison drift remains failed and is not upgraded to ready', () => {
  for (const outcome of ['moved_ref', 'missing_ref', 'symbolic_ref', 'aliased_ref']) {
    const result = projectRunApiBoundaryV1(validInput({
      audit: verifiedDriftAudit(outcome),
      orchestration: dispatchedOrchestration(),
      lifecycle: validLifecycle(),
    }));
    assert.equal(result.status, 'failed', outcome);
    assert.equal(result.audit.status, 'verified', outcome);
    assert.equal(result.audit.comparisons[0].outcome, outcome, outcome);
    assert.equal(result.audit.findings.length, 0, outcome);
    assert.equal(result.audit.observed_classes.length, 0, outcome);
    assert.equal(result.audit.facts[0].status, 'verified', outcome);
    assert.equal(result.audit.discrepancies.length, 0, outcome);
    assert.equal(result.orchestration.status, 'dispatched', outcome);
    assert.equal(result.lifecycle.cleaned, true, outcome);
    assertAdapterNonclaims(result);
    assertContentFree(result);
  }
});

test('P31 failed-preflight and capacity-denied inputs remain denied', () => {
  const preflight = projectRunApiBoundaryV1(validInput({
    orchestration: orchestrationDenial('repository_not_canonical'),
  }));
  assert.equal(preflight.status, 'denied');
  assert.equal(preflight.orchestration.kind, 'denial');
  assert.equal(preflight.orchestration.code, 'repository_not_canonical');
  assert.equal(preflight.audit.status, 'verified');
  assertAdapterNonclaims(preflight);
  assertContentFree(preflight);

  const cpu = projectRunApiBoundaryV1(validInput({
    orchestration: orchestrationDenial('host_cpu_capacity_exceeded'),
  }));
  assert.equal(cpu.status, 'denied');
  assert.equal(cpu.orchestration.code, 'host_cpu_capacity_exceeded');

  const ram = projectRunApiBoundaryV1(validInput({
    orchestration: orchestrationDenial('host_ram_capacity_exceeded', {
      schema: RUN_ORCHESTRATION_SCHEMA_ID,
      version: 1,
    }),
  }));
  assert.equal(ram.status, 'denied');
  assert.equal(ram.orchestration.code, 'host_ram_capacity_exceeded');
});

test('P31 cleanup-unresolved lifecycle remains unresolved and is not normalized away', () => {
  const result = projectRunApiBoundaryV1(validInput({
    orchestration: dispatchedOrchestration(),
    lifecycle: unresolvedLifecycle(),
  }));
  assert.equal(result.status, 'unresolved');
  assert.equal(result.lifecycle.cleaned, false);
  assert.equal(result.lifecycle.unresolved[0].code, 'handoff_cleanup_failed');
  assert.equal(result.audit.status, 'verified');
  assert.equal(result.orchestration.status, 'dispatched');
  assertAdapterNonclaims(result);
  assertContentFree(result);
});

test('failed audit is not upgraded by a successful orchestration or clean lifecycle', () => {
  const result = projectRunApiBoundaryV1(validInput({
    audit: failedAudit('moved_ref'),
    orchestration: dispatchedOrchestration(),
    lifecycle: validLifecycle(),
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.audit.status, 'failed');
  assert.equal(result.lifecycle.cleaned, true);
});

test('identity base provider and lane mismatches fail closed', () => {
  assert.equal(errorOf(() => projectRunApiBoundaryV1(validInput({
    identity: { run_id: 'run-other-identity' },
  }))).code, 'identity_mismatch');
  assert.equal(errorOf(() => projectRunApiBoundaryV1(validInput({
    identity: { base_sha: 'aaaabbbbccccddddeeeeffff0000111122223333' },
  }))).code, 'identity_mismatch');
  assert.equal(errorOf(() => projectRunApiBoundaryV1(validInput({
    identity: { assignment_id: ASSIGNMENT_ID_B },
  }))).code, 'identity_mismatch');
  assert.equal(errorOf(() => projectRunApiBoundaryV1(validInput({
    identity: { provider: 'cursor-local' },
  }))).code, 'identity_mismatch');
});

test('two-lane receipts bind the declared lane and drop nested path-shaped preflight fields', () => {
  const result = projectRunApiBoundaryV1(validInput({
    orchestration: validOrchestration({
      lanes: [
        validLane(),
        validLane({
          assignment_id: ASSIGNMENT_ID_B,
          provider: 'cursor-local',
          model: 'composer-1',
          identity: LANE_IDENTITY_B,
          projected_keys: ['GIT_TERMINAL_PROMPT'],
          credential_present: false,
        }),
      ],
    }),
  }));
  assert.equal(result.status, 'ready');
  assert.equal(result.orchestration.lanes.length, 2);
  assert.equal(result.orchestration.lanes[1].assignment_id, ASSIGNMENT_ID_B);
  assert.equal(result.orchestration.lanes[1].provider, 'cursor-local');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(HOSTILE_PATH), false);
  assert.equal(serialized.includes('.git'), false);
  assert.equal(serialized.includes('XAI_API_KEY'), false);
});

test('deep freeze detaches from later input mutation and repeated calls do not cross-contaminate', () => {
  const input = validInput();
  const ready = projectRunApiBoundaryV1(input);
  input.audit.status = 'failed';
  input.identity.run_id = 'run-mutated-after';
  input.orchestration.status = 'dispatched';
  assert.equal(ready.status, 'ready');
  assert.equal(ready.audit.status, 'verified');
  assert.equal(ready.run_id, RUN_ID);
  assert.throws(() => {
    ready.status = 'failed';
  });
  assert.throws(() => {
    ready.audit.findings.push({ code: 'moved_ref' });
  });
  const failed = projectRunApiBoundaryV1(validInput({ audit: failedAudit('missing_ref') }));
  assert.equal(ready.status, 'ready');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.audit.findings[0].code, 'missing_ref');
  assert.notEqual(JSON.stringify(ready), JSON.stringify(failed));
});

test('concurrent pure projections keep distinct ready and failed results', async () => {
  const [ready, failed, denied, unresolved] = await Promise.all([
    Promise.resolve(projectRunApiBoundaryV1(validInput())),
    Promise.resolve(projectRunApiBoundaryV1(validInput({ audit: failedAudit('moved_ref') }))),
    Promise.resolve(projectRunApiBoundaryV1(validInput({
      orchestration: orchestrationDenial('host_cpu_capacity_exceeded'),
    }))),
    Promise.resolve(projectRunApiBoundaryV1(validInput({
      lifecycle: unresolvedLifecycle(),
    }))),
  ]);
  assert.equal(ready.status, 'ready');
  assert.equal(failed.status, 'failed');
  assert.equal(denied.status, 'denied');
  assert.equal(unresolved.status, 'unresolved');
  assert.equal(ready.audit.status, 'verified');
  assert.equal(failed.audit.status, 'failed');
});
