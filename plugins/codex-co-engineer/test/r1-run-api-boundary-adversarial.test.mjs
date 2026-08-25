// P32 run API boundary — adversarial coverage: forged schema/version/status,
// unknown keys, Proxy/getter/exotic prototype/cycle, post-validation mutation,
// oversized collections, hostile toJSON/inspection/error text, secret and
// path-shaped values, and static/dynamic no-I/O proof. Projection never
// executes P30 audit, P31 lifecycle, Git, fs, process, network, or credentials.

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs, { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspect, types as utilTypes } from 'node:util';

import { MAX_AUDIT_REFS } from '../mcp/v3/protected-ref-audit.mjs';
import {
  MAX_API_COLLECTION,
  MAX_API_KEY_BYTES,
  MAX_API_OBJECT_KEYS,
  projectRunApiBoundaryV1,
} from '../mcp/v3/run-api-boundary.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  CONTENT_FREE,
  HOSTILE_ENV,
  HOSTILE_GIT,
  HOSTILE_PATH,
  HOSTILE_SECRET,
  HOSTILE_TOKEN,
  HOSTILE_URL,
  countingProxy,
  failedAudit,
  orchestrationDenial,
  orchestrationSideEffects,
  trapTotal,
  validAudit,
  validComparison,
  validInput,
  validLifecycle,
  validOrchestration,
  verifiedDriftAudit,
} from './fixtures/r1-run-api-boundary-fixtures.mjs';

const ADAPTER_SOURCE = readFileSync(
  fileURLToPath(new URL('../mcp/v3/run-api-boundary.mjs', import.meta.url)),
  'utf8',
);

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    assert.equal(utilTypes.isProxy(error), false);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function assertPublicFailure(error, extras = []) {
  assert.ok(error instanceof RunContractV1Error);
  assertContentFree(error, extras);
  assertContentFree(error.path, extras);
  assertContentFree(error.message, extras);
  assertContentFree(inspect({
    name: error.name, code: error.code, path: error.path, message: error.message,
  }, { depth: 4, getters: true }), extras);
  assert.equal(String(error.message).includes('TypeError'), false);
  assert.ok(Buffer.byteLength(error.message, 'utf8') <= 200);
}

function assertContentFree(value, extras = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes('/tmp'), false);
  assert.equal(text.includes('https://'), false);
  assert.equal(text.includes('git@'), false);
  assert.equal(text.includes(HOSTILE_PATH), false);
  assert.equal(text.includes(HOSTILE_URL), false);
  assert.equal(text.includes(HOSTILE_GIT), false);
  assert.equal(text.includes(HOSTILE_SECRET), false);
  assert.equal(text.includes(HOSTILE_TOKEN), false);
  assert.equal(text.includes(HOSTILE_ENV), false);
  for (const extra of extras) {
    if (typeof extra === 'string' && extra.length > 0 && extra.length < 500) {
      assert.equal(text.includes(extra), false, `leaked ${JSON.stringify(extra)}`);
    }
  }
  if (typeof value === 'string' && value.length <= 200 && !value.includes('\n') && !value.startsWith('{')) {
    assert.match(value, CONTENT_FREE);
  }
  if (typeof value === 'object' && value && typeof value.message === 'string') {
    assert.match(value.message, CONTENT_FREE);
  }
}

function assertRejected(action, extras = []) {
  const error = errorOf(action);
  assertPublicFailure(error, extras);
  return error;
}

test('forged schema version and status fail closed without leaking caller bytes', () => {
  const schema = assertRejected(() => projectRunApiBoundaryV1(validInput({
    schema: 'codex-co-engineer.run-orchestration.v1',
  })));
  assert.equal(schema.code, 'invalid_format');

  const version = assertRejected(() => projectRunApiBoundaryV1(validInput({ version: 2 })));
  assert.equal(version.code, 'invalid_format');

  const auditSchema = assertRejected(() => projectRunApiBoundaryV1(validInput({
    audit: validAudit({ schema: 'codex-co-engineer.git-authority.v1' }),
  })));
  assert.equal(auditSchema.code, 'invalid_format');

  const auditStatus = assertRejected(() => projectRunApiBoundaryV1(validInput({
    audit: validAudit({ status: 'ready' }),
  })));
  assert.equal(auditStatus.code, 'invalid_format');

  const orchestrationStatus = assertRejected(() => projectRunApiBoundaryV1(validInput({
    orchestration: validOrchestration({ status: 'verified' }),
  })));
  assert.equal(orchestrationStatus.code, 'invalid_format');
});

test('missing duplicate alias and unknown keys fail closed', () => {
  const missing = validInput();
  delete missing.audit;
  assert.equal(assertRejected(() => projectRunApiBoundaryV1(missing)).code, 'missing_key');

  const unknown = validInput();
  unknown.extra = true;
  assert.equal(assertRejected(() => projectRunApiBoundaryV1(unknown)).code, 'unknown_key');

  const auditUnknown = validInput();
  auditUnknown.audit = validAudit({ ref: 'refs/heads/main' });
  assert.equal(assertRejected(() => projectRunApiBoundaryV1(auditUnknown)).code, 'unknown_key');

  const duplicateLane = validInput({
    orchestration: validOrchestration({
      lanes: [
        { ...validInput().orchestration.lanes[0] },
        { ...validInput().orchestration.lanes[0], identity: 'aa'.repeat(16) },
      ],
    }),
  });
  assert.equal(assertRejected(() => projectRunApiBoundaryV1(duplicateLane)).code, 'invalid_format');

  const aliased = validInput();
  aliased.audit.facts = aliased.orchestration.lanes;
  assert.equal(assertRejected(() => projectRunApiBoundaryV1(aliased)).code, 'aliased_reference_denied');
});

test('proxy accessor symbol exotic prototype and cycles fail closed without running traps', () => {
  const { proxy, counts } = countingProxy(validInput());
  assert.equal(assertRejected(() => projectRunApiBoundaryV1(proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);

  const accessor = validInput();
  Object.defineProperty(accessor, 'audit', {
    get() { throw new Error(`accessor ran ${HOSTILE_SECRET}`); },
    enumerable: true,
  });
  const accessorError = assertRejected(() => projectRunApiBoundaryV1(accessor), [HOSTILE_SECRET]);
  assert.ok(['accessor_property_denied', 'invalid_type'].includes(accessorError.code), accessorError.code);

  const symbolKeyed = validInput();
  symbolKeyed[Symbol('secret')] = HOSTILE_TOKEN;
  assert.equal(assertRejected(() => projectRunApiBoundaryV1(symbolKeyed), [HOSTILE_TOKEN]).code, 'symbol_key_denied');

  const exotic = validInput();
  Object.setPrototypeOf(exotic, { toJSON() { return HOSTILE_SECRET; } });
  assert.equal(assertRejected(() => projectRunApiBoundaryV1(exotic), [HOSTILE_SECRET]).code, 'exotic_prototype_denied');

  const cyclic = validInput();
  cyclic.audit.comparisons.push(cyclic.audit.comparisons[0]);
  assert.equal(assertRejected(() => projectRunApiBoundaryV1(cyclic)).code, 'aliased_reference_denied');
});

test('post-validation mutation of input cannot change a frozen result', () => {
  const input = validInput();
  const result = projectRunApiBoundaryV1(input);
  input.audit = failedAudit('moved_ref');
  input.orchestration = orchestrationDenial('host_cpu_capacity_exceeded');
  input.identity.provider = 'dsh';
  assert.equal(result.status, 'ready');
  assert.equal(result.audit.status, 'verified');
  assert.equal(result.provider, 'grok');
  assert.throws(() => { result.invariants.remote_mutated = true; });
  assert.throws(() => { result.side_effects.gate_a_claimed = true; });
});

test('oversized collections and strings fail closed without echoing attacker bytes', () => {
  const huge = 'a'.repeat(1024);
  const hugeRun = assertRejected(
    () => projectRunApiBoundaryV1(validInput({ identity: { run_id: huge } })),
    [huge],
  );
  assert.ok(['bounds_exceeded', 'invalid_format'].includes(hugeRun.code), hugeRun.code);

  const comparisons = [];
  for (let i = 0; i < MAX_AUDIT_REFS + 1; i += 1) comparisons.push(validComparison());
  const oversized = assertRejected(() => projectRunApiBoundaryV1(validInput({
    audit: validAudit({
      comparisons,
      observation: {
        command_count: 2,
        compared_count: comparisons.length,
        duration_ms: 1,
        loose_count: comparisons.length,
        missing_count: 0,
        packed_count: 0,
        symbolic_count: 0,
      },
    }),
  })));
  assert.equal(oversized.code, 'bounds_exceeded');
  assert.ok(MAX_API_COLLECTION >= 1);
  assert.ok(MAX_API_OBJECT_KEYS >= 8);
  assert.ok(MAX_API_KEY_BYTES >= 8);

  const pathBomb = `${HOSTILE_PATH}/${'x'.repeat(5000)}`;
  const dropped = validInput();
  dropped.orchestration.preflight.repository.path = pathBomb;
  const pathError = assertRejected(() => projectRunApiBoundaryV1(dropped), [pathBomb, HOSTILE_PATH]);
  assert.equal(pathError.code, 'bounds_exceeded');
});

test('hostile toJSON inspection and error text never leak secrets or paths', () => {
  const poisoned = validInput();
  poisoned.toJSON = () => ({ secret: HOSTILE_SECRET, url: HOSTILE_URL });
  const toJsonError = assertRejected(
    () => projectRunApiBoundaryV1(poisoned),
    [HOSTILE_SECRET, HOSTILE_URL],
  );
  assert.ok(['unknown_key', 'invalid_type'].includes(toJsonError.code), toJsonError.code);

  const result = projectRunApiBoundaryV1(validInput());
  const inspected = inspect(result, { depth: 8, getters: true, showHidden: true });
  assertContentFree(inspected);
  assertContentFree(JSON.stringify(result));

  const denial = assertRejected(() => projectRunApiBoundaryV1(validInput({
    identity: { run_id: HOSTILE_URL },
  })), [HOSTILE_URL, 'token=secret']);
  assert.equal(denial.code, 'invalid_format');
});

test('secret and path-shaped identity values fail closed without leaking content', () => {
  const cases = [
    { run_id: HOSTILE_URL },
    { run_id: HOSTILE_PATH },
    { assignment_id: '../main' },
    { assignment_id: HOSTILE_SECRET },
    { base_sha: HOSTILE_TOKEN },
    { provider: HOSTILE_GIT },
  ];
  for (const override of cases) {
    const extras = Object.values(override).filter((value) => typeof value === 'string' && value.length < 200);
    const error = assertRejected(
      () => projectRunApiBoundaryV1(validInput({ identity: override })),
      extras,
    );
    assert.ok(['invalid_format', 'identity_mismatch'].includes(error.code), error.code);
  }
});

test('adapter source and dynamic projection never invoke I/O credential or lifecycle mechanisms', () => {
  assert.equal(ADAPTER_SOURCE.includes('auditProtectedRefsV1'), false);
  assert.equal(ADAPTER_SOURCE.includes('parseProtectedRefAuditRequestV1'), false);
  assert.equal(ADAPTER_SOURCE.includes('orchestrateRunDispatchV1'), false);
  assert.equal(ADAPTER_SOURCE.includes('cancelRunDispatchV1'), false);
  assert.equal(ADAPTER_SOURCE.includes('completeRunDispatchV1'), false);
  assert.equal(ADAPTER_SOURCE.includes('restartRunDispatchV1'), false);
  assert.equal(ADAPTER_SOURCE.includes('denyRunRemoteMutationV1'), false);
  assert.equal(ADAPTER_SOURCE.includes('validateRunPreflightV1'), false);
  assert.equal(ADAPTER_SOURCE.includes('createCredentialHandoff'), false);
  assert.equal(ADAPTER_SOURCE.includes('materializeProviderEnvironment'), false);
  assert.equal(ADAPTER_SOURCE.includes('node:fs'), false);
  assert.equal(ADAPTER_SOURCE.includes('node:child_process'), false);
  assert.equal(ADAPTER_SOURCE.includes('node:net'), false);
  assert.equal(ADAPTER_SOURCE.includes('node:http'), false);
  assert.equal(ADAPTER_SOURCE.includes('node:https'), false);
  assert.equal(ADAPTER_SOURCE.includes('process.env'), false);
  assert.equal(ADAPTER_SOURCE.includes('process.argv'), false);

  let calls = 0;
  const bump = (...args) => { calls += 1; return args; };
  const spawnOrig = childProcess.spawn;
  const execOrig = childProcess.execFile;
  const readOrig = fs.readFileSync;
  const writeOrig = fs.writeFileSync;
  const connectOrig = net.connect;
  const requestOrig = http.request;
  const envOrig = process.env;
  childProcess.spawn = (...args) => { bump(); return spawnOrig(...args); };
  childProcess.execFile = (...args) => { bump(); return execOrig(...args); };
  fs.readFileSync = (...args) => { bump(); return readOrig(...args); };
  fs.writeFileSync = (...args) => { bump(); return writeOrig(...args); };
  net.connect = (...args) => { bump(); return connectOrig(...args); };
  http.request = (...args) => { bump(); return requestOrig(...args); };
  try {
    const ready = projectRunApiBoundaryV1(validInput());
    const failed = projectRunApiBoundaryV1(validInput({ audit: failedAudit('moved_ref') }));
    const denied = projectRunApiBoundaryV1(validInput({
      orchestration: orchestrationDenial('host_ram_capacity_exceeded'),
    }));
    assert.equal(ready.status, 'ready');
    assert.equal(failed.status, 'failed');
    assert.equal(denied.status, 'denied');
    assert.equal(calls, 0);
    assert.equal(process.env, envOrig);
  } finally {
    childProcess.spawn = spawnOrig;
    childProcess.execFile = execOrig;
    fs.readFileSync = readOrig;
    fs.writeFileSync = writeOrig;
    net.connect = connectOrig;
    http.request = requestOrig;
  }
});

test('verified comparison drift cannot be upgraded to ready by a clean P31 receipt', () => {
  for (const outcome of ['moved_ref', 'missing_ref', 'symbolic_ref', 'aliased_ref']) {
    const result = projectRunApiBoundaryV1(validInput({ audit: verifiedDriftAudit(outcome) }));
    assert.equal(result.status, 'failed', outcome);
    assert.equal(result.audit.status, 'verified', outcome);
    assert.equal(result.audit.comparisons[0].outcome, outcome, outcome);
    assert.equal(result.orchestration.status, 'prepared', outcome);
    assert.equal(result.orchestration.side_effects.task_dispatched, false, outcome);
    assertContentFree(result);
  }

  const mixed = projectRunApiBoundaryV1(validInput({
    audit: verifiedDriftAudit('moved_ref', {
      comparisons: [validComparison(), validComparison({ outcome: 'moved_ref' })],
      observation: {
        command_count: 2,
        compared_count: 2,
        duration_ms: 1,
        loose_count: 2,
        missing_count: 0,
        packed_count: 0,
        symbolic_count: 0,
      },
    }),
  }));
  assert.equal(mixed.status, 'failed');
  assert.equal(mixed.audit.status, 'verified');
  assert.equal(mixed.audit.comparisons[0].outcome, 'match');
  assert.equal(mixed.audit.comparisons[1].outcome, 'moved_ref');
});

test('prepared receipts claiming dispatch side effects fail closed', () => {
  for (const flag of ['task_dispatched', 'provider_process_started']) {
    const error = assertRejected(() => projectRunApiBoundaryV1(validInput({
      orchestration: validOrchestration({
        side_effects: orchestrationSideEffects({
          credentials_projected: true,
          [flag]: true,
        }),
      }),
    })));
    assert.equal(error.code, 'invalid_format', flag);
  }

  const both = assertRejected(() => projectRunApiBoundaryV1(validInput({
    orchestration: validOrchestration({
      side_effects: orchestrationSideEffects({
        credentials_projected: true,
        task_dispatched: true,
        provider_process_started: true,
      }),
    }),
  })));
  assert.equal(both.code, 'invalid_format');

  const lifecycle = assertRejected(() => projectRunApiBoundaryV1(validInput({
    lifecycle: validLifecycle({
      side_effects: orchestrationSideEffects({ task_dispatched: true }),
    }),
  })));
  assert.equal(lifecycle.code, 'invalid_format');

  const processLifecycle = assertRejected(() => projectRunApiBoundaryV1(validInput({
    lifecycle: validLifecycle({
      side_effects: orchestrationSideEffects({ provider_process_started: true }),
    }),
  })));
  assert.equal(processLifecycle.code, 'invalid_format');
});

test('nested hostile credential env argv and handoff-shaped fields are not projected', () => {
  const input = validInput();
  input.orchestration.preflight.repository.path = HOSTILE_PATH;
  input.orchestration.preflight.repository.git_dir = `${HOSTILE_PATH}/.git`;
  input.orchestration.preflight.git_identity.repository_path = HOSTILE_PATH;
  input.orchestration.lanes[0].projected_keys = ['XAI_API_KEY', 'GIT_SSH_COMMAND'];
  input.orchestration.lanes[0].identity = 'ab'.repeat(16);
  const result = projectRunApiBoundaryV1(input);
  assert.equal(result.status, 'ready');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(HOSTILE_PATH), false);
  assert.equal(serialized.includes('XAI_API_KEY'), false);
  assert.equal(serialized.includes('GIT_SSH_COMMAND'), false);
  assert.equal(serialized.includes(input.orchestration.lanes[0].identity), false);
  assert.equal(Object.hasOwn(result.orchestration, 'preflight'), false);
  assertContentFree(result);
});
