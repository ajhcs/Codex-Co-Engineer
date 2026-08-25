import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUEST_ID_PATTERN,
  SELECTION_REQUEST_SCHEMA_ID,
  normalizeProviderAvailabilityV1,
  resolveRunSelectionV1,
  selectionRequestIdentity,
  validateSelectionRequestV1,
} from '../mcp/v3/resolver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import {
  BASE_SHA,
  availabilitySnapshot,
  capabilitySnapshot,
  profileCatalog,
  profileRecord,
  resolveInputs,
  reviewer,
  runManifest,
  writer,
} from './fixtures/r1-resolver-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

test('explicit execution wins and a complete run binds availability plus capability digests', () => {
  const manifest = runManifest([writer('lane-0', ['src/**'], { provider: 'grok', model: 'grok-4' })]);
  const plan = resolveRunSelectionV1(resolveInputs(manifest));
  assert.equal(plan.complete, true);
  assert.equal(plan.selection_request, null);
  assert.equal(plan.assignments[0].reason, 'explicit_assignment');
  assert.equal(plan.assignments[0].provider, 'grok');
  assert.equal(plan.assignments[0].requested_model, 'grok-4');
  assert.match(plan.availability_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(plan.capability_snapshot_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(plan.availability.digest, plan.availability_digest);
  assert.equal(plan.capabilities.digest, plan.capability_snapshot_digest);
});

test('authored precedence is assignment profile, then run profile, then default:true', () => {
  const profiles = profileCatalog([
    profileRecord('lane-review', { provider: 'grok', model: 'grok-4' }),
    profileRecord('run-fill', { provider: 'cursor-local', model: 'composer-1' }),
    profileRecord('catalog-default', { provider: 'dsh', model: 'stealth/ox-alpha', default: true }),
  ]);

  const assignmentProfile = runManifest(
    [reviewer('lane-0', 'omitted')],
    { profile: 'run-fill' },
  );
  assignmentProfile.assignments[0].execution = { profile: 'lane-review' };
  const fromAssignment = resolveRunSelectionV1(resolveInputs(assignmentProfile, { profiles }));
  assert.equal(fromAssignment.assignments[0].reason, 'assignment_profile');
  assert.equal(fromAssignment.assignments[0].provider, 'grok');
  assert.equal(fromAssignment.complete, true);

  const fromRun = resolveRunSelectionV1(resolveInputs(
    runManifest([reviewer('lane-0', 'omitted')], { profile: 'run-fill' }),
    { profiles },
  ));
  assert.equal(fromRun.assignments[0].reason, 'run_profile');
  assert.equal(fromRun.assignments[0].provider, 'cursor-local');

  const fromDefault = resolveRunSelectionV1(resolveInputs(
    runManifest([reviewer('lane-0', 'omitted')]),
    { profiles },
  ));
  assert.equal(fromDefault.assignments[0].reason, 'default_profile');
  assert.equal(fromDefault.assignments[0].provider, 'dsh');
});

test('a profile named default has no authority by name', () => {
  const profiles = profileCatalog([
    profileRecord('default', { provider: 'grok', model: 'grok-4' }),
  ]);
  const plan = resolveRunSelectionV1(resolveInputs(
    runManifest([reviewer('lane-0', 'omitted')]),
    { profiles },
  ));
  assert.equal(plan.complete, false);
  assert.equal(plan.assignments[0].reason, 'provider_missing');
  assert.equal(plan.assignments[0].reason_class, 'missing');
});

test('assignment-named missing profile does not fall through to the run profile', () => {
  const profiles = profileCatalog([
    profileRecord('run-fill', { provider: 'grok', model: 'grok-4' }),
  ]);
  const manifest = runManifest(
    [reviewer('lane-0', 'omitted')],
    { profile: 'run-fill' },
  );
  manifest.assignments[0].execution = { profile: 'missing-lane' };
  const plan = resolveRunSelectionV1(resolveInputs(manifest, { profiles }));
  assert.equal(plan.complete, false);
  assert.equal(plan.assignments[0].reason, 'profile_not_found');
  assert.notEqual(plan.assignments[0].provider, 'grok');
});

test('models null or absent means undeclared for every provider, including DSH', () => {
  const availability = availabilitySnapshot({
    dsh: { status: 'available' },
    grok: { status: 'available', models: null },
  });
  const dshUnlisted = runManifest([
    writer('lane-0', ['src/**'], { provider: 'dsh', model: 'future-dsh-model' }),
  ]);
  const dshPlan = resolveRunSelectionV1(resolveInputs(dshUnlisted, { availability }));
  assert.equal(dshPlan.complete, true, 'DSH must not require a models list');
  assert.equal(dshPlan.assignments[0].requested_model, 'future-dsh-model');

  const grokUnlisted = runManifest([
    writer('lane-0', ['src/**'], { provider: 'grok', model: 'unlisted-grok/model.9' }),
  ]);
  const grokPlan = resolveRunSelectionV1(resolveInputs(grokUnlisted, { availability }));
  assert.equal(grokPlan.complete, true);
});

test('declared membership rejects a missing model as model_unavailable after model_ambiguous', () => {
  const availability = availabilitySnapshot({
    grok: { status: 'available', models: ['grok-4'] },
  });
  const missingModel = runManifest([reviewer('lane-0', 'omitted')], { profile: 'grok-fill' });
  const profiles = profileCatalog([
    profileRecord('grok-fill', { provider: 'grok' }),
  ]);
  const ambiguous = resolveRunSelectionV1(resolveInputs(missingModel, { availability, profiles }));
  assert.equal(ambiguous.assignments[0].reason, 'model_ambiguous');
  assert.equal(ambiguous.assignments[0].answer_scope, 'model_only');
  assert.equal(ambiguous.complete, false);

  const unlisted = runManifest([
    writer('lane-0', ['src/**'], { provider: 'grok', model: 'not-offered' }),
  ]);
  const unavailable = resolveRunSelectionV1(resolveInputs(unlisted, { availability }));
  assert.equal(unavailable.assignments[0].reason, 'model_unavailable');
  assert.equal(unavailable.complete, false);
});

test('a one-element models list is never a hidden default', () => {
  const availability = availabilitySnapshot({
    grok: { status: 'available', models: ['grok-4'] },
  });
  const profiles = profileCatalog([
    profileRecord('grok-only', { provider: 'grok' }),
  ]);
  const plan = resolveRunSelectionV1(resolveInputs(
    runManifest([reviewer('lane-0', 'omitted')], { profile: 'grok-only' }),
    { availability, profiles },
  ));
  assert.equal(plan.assignments[0].reason, 'model_ambiguous');
  assert.equal(plan.assignments[0].requested_model, null);
});

test('unavailable and unsupported providers stay unresolved and are never substituted', () => {
  const availability = availabilitySnapshot({
    grok: { status: 'unavailable', models: ['grok-4'] },
    dsh: null,
  });
  const unavailable = resolveRunSelectionV1(resolveInputs(
    runManifest([writer('lane-0', ['src/**'], { provider: 'grok', model: 'grok-4' })]),
    { availability },
  ));
  assert.equal(unavailable.assignments[0].reason, 'provider_unavailable');
  assert.equal(unavailable.assignments[0].provider, 'grok');

  const unsupported = resolveRunSelectionV1(resolveInputs(
    runManifest([writer('lane-0', ['src/**'], { provider: 'dsh', model: 'stealth/ox-alpha' })]),
    { availability },
  ));
  assert.equal(unsupported.assignments[0].reason, 'provider_unsupported');
  assert.notEqual(unsupported.assignments[0].provider, 'grok');
});

test('not_supported exact-model posture is never selectable', () => {
  const capabilities = capabilitySnapshot({
    grok: { exact_model_selection: 'not_supported' },
  });
  const error = errorOf(() => resolveRunSelectionV1(resolveInputs(
    runManifest([writer('lane-0', ['src/**'], { provider: 'grok', model: 'grok-4' })]),
    { capabilities },
  )));
  assert.equal(error.code, 'exact_model_selection_unsupported');
});

test('Cursor Cloud resolved lanes require a pinned starting_ref; local lanes reject one', () => {
  const cloudMissing = runManifest([
    writer('lane-0', ['src/**'], { provider: 'cursor-cloud', model: 'claude-sonnet-4-5' }),
  ]);
  assert.equal(
    errorOf(() => resolveRunSelectionV1(resolveInputs(cloudMissing))).code,
    'cloud_starting_ref_required',
  );

  const cloudPinned = runManifest([
    {
      ...writer('lane-0', ['src/**'], { provider: 'cursor-cloud', model: 'claude-sonnet-4-5' }),
      starting_ref: BASE_SHA,
    },
  ]);
  const cloudPlan = resolveRunSelectionV1(resolveInputs(cloudPinned));
  assert.equal(cloudPlan.complete, true);
  assert.equal(cloudPlan.assignments[0].provider, 'cursor-cloud');

  const localPinned = runManifest([
    {
      ...writer('lane-0', ['src/**'], { provider: 'grok', model: 'grok-4' }),
      starting_ref: BASE_SHA,
    },
  ]);
  assert.equal(
    errorOf(() => resolveRunSelectionV1(resolveInputs(localPinned))).code,
    'starting_ref_forbidden_local',
  );
});

test('SelectionRequestV1 identity is sel- plus 32 lowercase hex and binds both snapshot digests', () => {
  const plan = resolveRunSelectionV1(resolveInputs(runManifest([reviewer('lane-0', 'omitted')])));
  const request = plan.selection_request;
  assert.equal(request.schema, SELECTION_REQUEST_SCHEMA_ID);
  assert.match(request.request_id, REQUEST_ID_PATTERN);
  assert.equal(request.request_id.length, 4 + 32);
  assert.equal(request.availability_digest, plan.availability_digest);
  assert.equal(request.capability_snapshot_digest, plan.capability_snapshot_digest);
  assert.equal(validateSelectionRequestV1(request), true);
  const identity = selectionRequestIdentity(request);
  assert.deepEqual(identity, {
    run_id: request.run_id,
    request_id: request.request_id,
    digest: request.digest,
  });
});

test('deterministic rerun of the same inputs yields an identical plan', () => {
  const manifest = runManifest([reviewer('lane-0', 'omitted'), reviewer('lane-1', 'explicit')]);
  const inputs = resolveInputs(manifest, {
    profiles: profileCatalog([profileRecord('unused', { provider: 'grok', model: 'grok-4' })]),
  });
  const first = resolveRunSelectionV1(inputs);
  const second = resolveRunSelectionV1(inputs);
  assert.equal(canonicalJsonStringify(first), canonicalJsonStringify(second));
  assert.equal(first.selection_request.request_id, second.selection_request.request_id);
});

test('closed selection request schema rejects unknown keys and inherited required fields', () => {
  const plan = resolveRunSelectionV1(resolveInputs(runManifest([reviewer('lane-0', 'omitted')])));
  const request = { ...plan.selection_request, extra: true };
  assert.equal(errorOf(() => validateSelectionRequestV1(request)).code, 'unknown_selection_request_key');

  const inherited = { ...plan.selection_request };
  delete inherited.schema;
  assert.equal(errorOf(() => validateSelectionRequestV1(inherited)).code, 'missing_key');

  const proto = { schema: SELECTION_REQUEST_SCHEMA_ID };
  const exotic = Object.create(proto);
  for (const key of Object.keys(plan.selection_request)) {
    if (key !== 'schema') exotic[key] = plan.selection_request[key];
  }
  assert.equal(errorOf(() => validateSelectionRequestV1(exotic)).code, 'exotic_prototype_denied');
});

test('availability snapshot digest is origin-stable and models null stays undeclared', () => {
  const first = normalizeProviderAvailabilityV1(availabilitySnapshot({
    dsh: { status: 'available', models: null },
  }));
  const second = normalizeProviderAvailabilityV1(availabilitySnapshot({
    dsh: { status: 'available' },
  }));
  assert.equal(first.digest, second.digest);
  const dsh = first.providers.find((entry) => entry.provider === 'dsh');
  assert.equal(dsh.models, null);
});

test('capability snapshot drift changes the selection request identity', () => {
  const manifest = runManifest([reviewer('lane-0', 'omitted')]);
  const first = resolveRunSelectionV1(resolveInputs(manifest));
  const drifted = capabilitySnapshot({
    grok: { notes: 'drifted grok fixture' },
  });
  const second = resolveRunSelectionV1(resolveInputs(manifest, { capabilities: drifted }));
  assert.notEqual(first.capability_snapshot_digest, second.capability_snapshot_digest);
  assert.notEqual(first.selection_request.digest, second.selection_request.digest);
  assert.notEqual(first.selection_request.request_id, second.selection_request.request_id);
});
