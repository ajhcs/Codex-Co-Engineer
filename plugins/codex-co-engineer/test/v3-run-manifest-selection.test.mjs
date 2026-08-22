// Runtime tests for the P02R1 manifest prerequisite repair: assignment
// execution may be TRULY ABSENT, an optional root RunManifestV1 profile name
// may be bound with the exact already-owned bounded profile-name grammar,
// and both omitted-execution and named-profile lanes are classified
// selection_resolution_required while explicit provider/model lanes stay
// dispatch-resolved. Every hostile shape — null, empty, own undefined,
// partial pairs, unknown grammars, oversized or control-character names,
// proxies, getters, symbols, non-enumerable properties, exotic prototypes,
// cycles — still fails closed through the existing typed contract boundary
// without executing a single trap.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { types as utilTypes } from 'node:util';

import {
  ASSIGNMENT_SELECTION_STATES,
  BOUND_ROOT_PROFILE_KEY,
  PROFILE_NAME_MAX,
  PROFILE_NAME_PATTERN,
  RunContractV1Error,
  classifyAssignmentSelectionV1,
} from '../mcp/v3/run-manifest.mjs';
import {
  parseRunManifestV1,
  validateCompleteRunManifestV1,
} from '../mcp/v3/run-policy.mjs';
import { runManifestDigestV1 } from '../mcp/v3/identity.mjs';

const BASE_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const POLICY = Object.freeze({
  max_concurrency: 8,
  require_same_base: true,
  require_disjoint_writer_scopes: true,
  allow_post_dispatch_fallback: false,
  allow_merge: false,
  allow_create_pr: false,
  attention_mode: 'aggregate',
  completion_mode: 'all_settled_then_verify',
});

const EXECUTION_KINDS = Object.freeze(['explicit', 'profile', 'omitted']);

function reviewer(id, kind) {
  const assignment = {
    assignment_id: id,
    role: 'review',
    access: 'read_only',
    prompt: `Review lane ${id}.`,
    write_scope: [],
    acceptance: [],
    expected_duration_ms: 600_000,
    required_evidence: ['provider_report', 'git_identity'],
  };
  if (kind === 'explicit') {
    assignment.execution = { provider: 'dsh', model: 'stealth/ox-alpha' };
  } else if (kind === 'profile') {
    assignment.execution = { profile: 'deep-security-review' };
  } else if (kind === 'pinned-omitted') {
    // An omitted-execution lane may pin the exact future Cloud SHA now;
    // whether the pin is required or forbidden stays a P05 decision.
    assignment.starting_ref = BASE_SHA;
  }
  return assignment;
}

function writer(id, scopes) {
  return {
    assignment_id: id,
    role: 'implement',
    access: 'writer',
    prompt: `Implement lane ${id}.`,
    execution: { provider: 'dsh', model: 'stealth/ox-alpha' },
    write_scope: scopes,
    acceptance: [{ command_id: 'unit-tests', timeout_ms: 600_000 }],
    expected_duration_ms: 1_200_000,
    required_evidence: ['provider_report', 'git_diff'],
  };
}

function run(assignments, overrides = {}) {
  return {
    schema: 'codex-co-engineer.run.v1',
    run_id: 'selection-resolution-run',
    repository: { path: '/repos/demo', base_sha: BASE_SHA },
    objective: 'Keep unresolved selections reachable but inert.',
    assignments,
    policy: { ...POLICY },
    return_contract: { mode: 'verified_decision', include_artifact_refs: true },
    ...overrides,
  };
}

function singleLane(mutate) {
  const manifest = run([writer('lane-0', ['src/**'])]);
  mutate(manifest.assignments[0], manifest);
  return manifest;
}

function violationOf(build) {
  try {
    validateCompleteRunManifestV1(build());
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected the mutated manifest to be rejected');
}

test('assignment execution may be truly absent and classifies as selection_resolution_required', () => {
  const manifest = singleLane((assignment) => { delete assignment.execution; });
  const summary = validateCompleteRunManifestV1(manifest);
  assert.equal(summary.selection_resolution_required, true);
  assert.deepEqual([...summary.selection_resolution_required_assignment_ids], ['lane-0']);
  // Legacy profile-only view stays untouched: absence is not a profile lane.
  assert.equal(summary.profile_resolution_required, false);
  assert.deepEqual([...summary.unresolved_profile_assignment_ids], []);
  assert.equal(classifyAssignmentSelectionV1(manifest.assignments[0]),
    'selection_resolution_required');
});

test('only the explicit provider/model pair stays dispatch-resolved', () => {
  assert.deepEqual([...ASSIGNMENT_SELECTION_STATES],
    ['dispatch_resolved', 'selection_resolution_required']);
  const kinds = [['explicit', 'dispatch_resolved'], ['profile', 'selection_resolution_required']];
  for (const [kind, expected] of kinds) {
    const manifest = run([reviewer('lane-0', kind)]);
    assert.equal(classifyAssignmentSelectionV1(manifest.assignments[0]), expected);
  }
});

test('every hostile PRESENT execution form keeps failing closed exactly as before', () => {
  const cases = [
    ['null execution', (a) => { a.execution = null; }, 'invalid_type', 'assignments[0].execution'],
    ['own undefined', (a) => { a.execution = undefined; }, 'invalid_type', 'assignments[0].execution'],
    ['empty object', (a) => { a.execution = {}; }, 'execution_missing', 'assignments[0].execution'],
    ['partial provider only', (a) => { a.execution = { provider: 'dsh' }; }, 'missing_key',
      'assignments[0].execution.model'],
    ['partial model only', (a) => { a.execution = { model: 'stealth/ox-alpha' }; }, 'missing_key',
      'assignments[0].execution.provider'],
    ['own undefined provider', (a) => {
      a.execution = { provider: undefined, model: 'stealth/ox-alpha' };
    }, 'unknown_provider', 'assignments[0].execution.provider'],
    ['unknown provider', (a) => { a.execution = { provider: 'sky-net', model: 'x' }; },
      'unknown_provider', 'assignments[0].execution.provider'],
    ['bad model grammar', (a) => { a.execution = { provider: 'dsh', model: 'stealth ox' }; },
      'invalid_format', 'assignments[0].execution.model'],
    ['profile plus provider', (a) => {
      a.execution = { profile: 'fast-lane', provider: 'dsh' };
    }, 'execution_ambiguous', 'assignments[0].execution'],
    ['profile plus model', (a) => {
      a.execution = { profile: 'fast-lane', model: 'stealth/ox-alpha' };
    }, 'execution_ambiguous', 'assignments[0].execution'],
    ['inline profile object', (a) => { a.execution = { profile: { name: 'fast' } }; },
      'invalid_type', 'assignments[0].execution.profile'],
    ['unknown profile grammar', (a) => { a.execution = { profile: '../escape' }; },
      'invalid_format', 'assignments[0].execution.profile'],
  ];
  for (const [name, mutate, code, expectedPath] of cases) {
    const error = violationOf(() => singleLane(mutate));
    assert.equal(error.code, code, name);
    assert.equal(error.path, expectedPath, name);
  }
  // Absence remains distinct from every rejection above: removing the key
  // validates the very manifest that every present hostile form fails.
  validateCompleteRunManifestV1(singleLane((assignment) => { delete assignment.execution; }));
});

test('the optional root profile binds when valid and stays optional when absent', () => {
  const unbound = run([writer('lane-0', ['src/**'])]);
  let summary = validateCompleteRunManifestV1(unbound);
  assert.equal(summary.bound_root_profile, null);

  const bound = run([reviewer('lane-0', 'omitted')], { [BOUND_ROOT_PROFILE_KEY]: 'cloud-default' });
  summary = validateCompleteRunManifestV1(bound);
  assert.equal(summary.bound_root_profile, 'cloud-default');
  // Binding resolves nothing: the omitted lane still requires selection.
  assert.equal(summary.selection_resolution_required, true);
  assert.deepEqual([...summary.selection_resolution_required_assignment_ids], ['lane-0']);
});

test('root profile rejects unknown, oversize, and hostile name forms', () => {
  const hostileNames = [
    ['number', 7], ['boolean', true], ['null', null], ['array', ['cloud-default']],
    ['object', { name: 'cloud-default' }], ['own undefined', undefined],
    ['uppercase', 'Cloud-Default'], ['path traversal', '../owner/profile'],
    ['separator', 'owner/profile'], ['whitespace', 'cloud default'], ['empty', ''],
    ['leading dot', '.hidden'],
  ];
  for (const [name, value] of hostileNames) {
    const error = violationOf(() => run([writer('lane-0', ['src/**'])],
      { [BOUND_ROOT_PROFILE_KEY]: value }));
    assert.ok(['invalid_type', 'invalid_format'].includes(error.code), `${name}: ${error.code}`);
    assert.match(error.message, /profile/u, name);
  }

  const oversize = 'a'.repeat(PROFILE_NAME_MAX + 1);
  assert.equal(violationOf(() => run([writer('lane-0', ['src/**'])],
    { profile: oversize })).code, 'invalid_format');

  const multibyteOversize = '\u00e9'.repeat(PROFILE_NAME_MAX); // 128 UTF-8 bytes
  assert.equal(violationOf(() => run([writer('lane-0', ['src/**'])],
    { profile: multibyteOversize })).code, 'invalid_format');

  for (const hostile of ['cloud\u0000default', 'cloud\u007fdefault', 'cloud\u202edefault']) {
    const error = violationOf(() => run([writer('lane-0', ['src/**'])], { profile: hostile }));
    assert.equal(error.code, 'invalid_format');
    assert.match(error.message, /profile-name grammar/u);
  }

  // The grammar itself is untouched and shared with execution.profile.
  assert.equal(String(PROFILE_NAME_PATTERN), '/^[a-z0-9][a-z0-9._-]{0,63}$/u');
  const atLimit = `${'a'.repeat(PROFILE_NAME_MAX - 2)}.9`; // exactly 64 chars
  assert.equal(validateCompleteRunManifestV1(run([writer('lane-0', ['src/**'])],
    { profile: atLimit })).bound_root_profile, atLimit);
});

test('the manifest contract imports nothing from the P04 profile catalog', async () => {
  const v3Dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'v3');
  for (const name of ['run-manifest.mjs', 'run-policy.mjs', 'assignment-manifest.mjs',
    'prompt-compiler.mjs', 'identity.mjs']) {
    const source = await readFile(path.join(v3Dir, name), 'utf8');
    assert.equal(source.includes("from './profile.mjs'"), false, `${name} imports P04`);
    assert.equal(source.includes('profile.mjs'), false, `${name} references P04`);
  }
});

test('mixed resolved and unresolved lanes classify exactly for every count 1..8', () => {
  for (let count = 1; count <= 8; count += 1) {
    const assignments = [];
    const expectedSelection = [];
    const expectedProfile = [];
    for (let index = 0; index < count; index += 1) {
      const kind = EXECUTION_KINDS[index % EXECUTION_KINDS.length];
      const id = `lane-${index}`;
      if (index === 1 && count >= 6) {
        assignments.push(writer(id, [`scope-${index}/**`]));
      } else {
        assignments.push(reviewer(id, kind));
      }
      const effectiveKind = index === 1 && count >= 6 ? 'explicit' : kind;
      if (effectiveKind !== 'explicit') expectedSelection.push(id);
      if (effectiveKind === 'profile') expectedProfile.push(id);
    }
    const summary = validateCompleteRunManifestV1(run(assignments));
    assert.equal(summary.assignment_count, count);
    assert.deepEqual([...summary.selection_resolution_required_assignment_ids], expectedSelection,
      `count ${count}`);
    assert.equal(summary.selection_resolution_required, expectedSelection.length > 0,
      `count ${count}`);
    assert.deepEqual([...summary.unresolved_profile_assignment_ids], expectedProfile,
      `count ${count}`);
    assert.equal(summary.profile_resolution_required, expectedProfile.length > 0,
      `count ${count}`);
  }

  // A fully explicit eight-lane run stays entirely dispatch-resolved.
  const explicitRun = run(Array.from({ length: 8 }, (_, index) => (
    index < 2
      ? writer(`lane-${index}`, [`scope-${index}/**`])
      : reviewer(`lane-${index}`, 'explicit')
  )));
  const explicitSummary = validateCompleteRunManifestV1(explicitRun);
  assert.equal(explicitSummary.selection_resolution_required, false);
  assert.deepEqual([...explicitSummary.selection_resolution_required_assignment_ids], []);
});

test('omitted-execution lanes keep the exact starting_ref deferral contract', () => {
  validateCompleteRunManifestV1(run([reviewer('lane-0', 'omitted'), reviewer('lane-1', 'pinned-omitted')]));

  const malformedPin = run([reviewer('lane-0', 'omitted')]);
  malformedPin.assignments[0].starting_ref = BASE_SHA.slice(0, 39);
  assert.equal(violationOf(() => malformedPin).code, 'invalid_format');
});

test('first-error ordering across the extended pipeline is fixed and insertion-order independent', () => {
  // Pipeline position: unknown root key > missing required key > objective >
  // root profile binding > return contract > policy > assignments.
  const unknownAndBadProfile = () => run([writer('lane-0', ['src/**'])],
    { [BOUND_ROOT_PROFILE_KEY]: 'BAD NAME', stray_root: true });
  assert.equal(violationOf(unknownAndBadProfile).path, '$.stray_root');

  const missingPolicyAndBadProfile = () => {
    const manifest = run([writer('lane-0', ['src/**'])], { [BOUND_ROOT_PROFILE_KEY]: 'BAD NAME' });
    delete manifest.policy;
    return manifest;
  };
  assert.equal(violationOf(missingPolicyAndBadProfile).code, 'missing_key');
  assert.equal(violationOf(missingPolicyAndBadProfile).path, '$.policy');

  const badObjectiveAndBadProfile = () => run([writer('lane-0', ['src/**'])],
    { objective: '   ', [BOUND_ROOT_PROFILE_KEY]: 'BAD NAME' });
  assert.equal(violationOf(badObjectiveAndBadProfile).path, 'objective');

  const badProfileAndBadFlag = () => {
    const manifest = run([writer('lane-0', ['src/**'])], { [BOUND_ROOT_PROFILE_KEY]: 'BAD NAME' });
    manifest.return_contract.allow_diagnostic_partial_candidate = 'yes';
    return manifest;
  };
  const forward = violationOf(badProfileAndBadFlag);
  assert.equal(forward.code, 'invalid_format');
  assert.equal(forward.path, BOUND_ROOT_PROFILE_KEY);

  const badProfileAndBadLane = () => {
    const manifest = run([writer('lane-0', ['src/**'])]);
    manifest.profile = 'BAD NAME';
    manifest.assignments[0].execution = { provider: 'sky-net', model: 'x' };
    return manifest;
  };
  assert.equal(violationOf(badProfileAndBadLane).path, BOUND_ROOT_PROFILE_KEY);

  // Identical violations built with reversed key insertion raise identical
  // first errors.
  const reverseInsertion = () => {
    const manifest = {
      return_contract: { allow_diagnostic_partial_candidate: 'yes',
        include_artifact_refs: true, mode: 'verified_decision' },
      profile: 'BAD NAME',
      policy: { ...POLICY },
      assignments: [writer('lane-0', ['src/**'])],
      objective: 'Keep unresolved selections reachable but inert.',
      repository: { base_sha: BASE_SHA, path: '/repos/demo' },
      run_id: 'selection-resolution-run',
      schema: 'codex-co-engineer.run.v1',
      stray_root: true,
    };
    return manifest;
  };
  const reversedError = violationOf(reverseInsertion);
  const forwardError = violationOf(unknownAndBadProfile);
  assert.equal(reversedError.code, forwardError.code);
  assert.equal(reversedError.path, forwardError.path);
  assert.equal(reversedError.message, forwardError.message);
});

test('proxy, getter, symbol, non-enumerable, exotic, and cyclic inputs fail closed without executing traps', () => {
  // Proxy standing in for execution: rejected by reflection alone.
  const proxiedExecution = singleLane((assignment) => {
    assignment.execution = new Proxy({ provider: 'dsh', model: 'stealth/ox-alpha' }, {});
  });
  let trapReads = 0;
  proxiedExecution.assignments[0].execution = new Proxy(
    proxiedExecution.assignments[0].execution, {
      get(target, key) { trapReads += 1; return target[key]; },
    },
  );
  const proxyError = violationOf(() => proxiedExecution);
  assert.equal(proxyError.code, 'invalid_type');
  assert.equal(proxyError.path, '$.assignments[0].execution');
  assert.ok(utilTypes.isProxy(proxiedExecution.assignments[0].execution));

  // Enumerable accessor masquerading as provider: never invoked.
  let getterCalls = 0;
  const accessor = singleLane((assignment) => { delete assignment.execution; });
  accessor.assignments[0].execution = {};
  Object.defineProperty(accessor.assignments[0].execution, 'provider', {
    enumerable: true,
    get() { getterCalls += 1; return 'dsh'; },
  });
  assert.equal(violationOf(() => accessor).code, 'invalid_object');
  assert.equal(getterCalls, 0);

  // Root-profile accessor is likewise inspected, never executed.
  let profileReads = 0;
  const profileAccessor = run([writer('lane-0', ['src/**'])]);
  Object.defineProperty(profileAccessor, BOUND_ROOT_PROFILE_KEY, {
    enumerable: true,
    get() { profileReads += 1; return 'cloud-default'; },
  });
  assert.equal(violationOf(() => profileAccessor).code, 'invalid_object');
  assert.equal(profileReads, 0);

  const symbolKeyed = singleLane((assignment) => {
    assignment.execution[Symbol('provider')] = 'dsh';
  });
  assert.equal(violationOf(() => symbolKeyed).code, 'invalid_object');

  const hiddenExecution = singleLane((assignment) => {
    const value = assignment.execution;
    delete assignment.execution;
    Object.defineProperty(assignment, 'execution', { value, enumerable: false });
  });
  assert.equal(violationOf(() => hiddenExecution).code, 'invalid_object');

  const exotic = singleLane((assignment) => {
    assignment.execution = Object.assign(Object.create({ injected: true }), {
      provider: 'dsh', model: 'stealth/ox-alpha',
    });
  });
  const exoticError = violationOf(() => exotic);
  assert.equal(exoticError.code, 'invalid_type');
  assert.equal(exoticError.path, '$.assignments[0].execution');

  const cyclic = singleLane((assignment) => {
    const execution = { provider: 'dsh', model: 'stealth/ox-alpha' };
    execution.self = execution;
    assignment.execution = execution;
  });
  assert.equal(violationOf(() => cyclic).code, 'invalid_json_value');

  // Null-prototype data remains acceptable plain JSON.
  const nullProto = singleLane((assignment) => {
    assignment.execution = Object.assign(Object.create(null), {
      provider: 'dsh', model: 'stealth/ox-alpha',
    });
  });
  validateCompleteRunManifestV1(nullProto);
});

test('parsing returns detached deeply frozen graphs with omission and presence preserved', () => {
  const source = run([
    reviewer('omitted-lane', 'omitted'),
    reviewer('profile-lane', 'profile'),
    writer('explicit-lane', ['src/**']),
  ], { [BOUND_ROOT_PROFILE_KEY]: 'cloud-default' });
  source.return_contract.allow_diagnostic_partial_candidate = false;

  const snapshot = parseRunManifestV1(source);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.assignments));
  assert.ok(Object.isFrozen(snapshot.return_contract));
  for (const assignment of snapshot.assignments) {
    assert.ok(Object.isFrozen(assignment));
    if (Object.hasOwn(assignment, 'execution')) assert.ok(Object.isFrozen(assignment.execution));
  }

  // Presence survives verbatim in both directions.
  assert.equal(Object.hasOwn(snapshot.assignments[0], 'execution'), false);
  assert.deepEqual({ ...snapshot.assignments[1].execution }, { profile: 'deep-security-review' });
  assert.equal(snapshot.return_contract.allow_diagnostic_partial_candidate, false);
  assert.equal(snapshot[BOUND_ROOT_PROFILE_KEY], 'cloud-default');

  // Detachment: mutating the caller's graph cannot reach the snapshot.
  source.assignments[0].prompt = 'mutated';
  if (source.assignments[1].execution) source.assignments[1].execution.profile = 'mutated';
  source.return_contract.allow_diagnostic_partial_candidate = true;
  source.profile = 'mutated';
  assert.equal(snapshot.assignments[0].prompt, 'Review lane omitted-lane.');
  assert.equal(snapshot.assignments[1].execution.profile, 'deep-security-review');
  assert.equal(snapshot.return_contract.allow_diagnostic_partial_candidate, false);
  assert.equal(snapshot[BOUND_ROOT_PROFILE_KEY], 'cloud-default');
  assert.throws(() => { snapshot.assignments.push(reviewer('extra', 'omitted')); }, TypeError);
});

test('pre-existing fully explicit manifests stay byte-identical through the digest', () => {
  const manifest = run([writer('lane-0', ['src/**']), reviewer('lane-1', 'explicit')]);
  const baseline = runManifestDigestV1(manifest);
  assert.equal(runManifestDigestV1(parseRunManifestV1(manifest)).digest, baseline.digest);
  // Same content minus the derived summary: digests depend on submitted
  // bytes only, so the repaired parser neither adds nor moves keys.
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(manifest))).includes('profile_resolution'), false);
});
