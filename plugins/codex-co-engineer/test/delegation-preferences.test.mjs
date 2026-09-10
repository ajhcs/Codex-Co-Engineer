import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inspectDelegationPreferencesV1,
  parseDelegationPreferencesV1,
  resolveAssignmentPreferenceV1,
} from '../mcp/v3/delegation-preferences.mjs';

test('omitted preferences preserve the explicit-provider path', () => {
  const parsed = parseDelegationPreferencesV1(undefined);
  assert.equal(parsed.attention, null);
  assert.deepEqual(parsed.by_role, {});
  const resolved = resolveAssignmentPreferenceV1({
    role: 'implement',
    provider: 'grok',
  }, parsed, 'run_request.assignments[0]');
  assert.equal(resolved.provider, 'grok');
  assert.equal(resolved.source, 'explicit');
  assert.equal(resolved.model, undefined);
});

test('role preferences fill omitted providers and keep exact selections', () => {
  const parsed = parseDelegationPreferencesV1({
    implement: { provider: 'grok' },
    review: { provider: 'cursor-local', model: 'composer-1' },
  });
  assert.equal(parsed.attention, null);
  const filled = resolveAssignmentPreferenceV1({
    role: 'implement',
  }, parsed, 'run_request.assignments[0]');
  assert.equal(filled.provider, 'grok');
  assert.equal(filled.source, 'preference');
  const explicit = resolveAssignmentPreferenceV1({
    role: 'implement',
    provider: 'cursor-local',
  }, parsed, 'run_request.assignments[0]');
  assert.equal(explicit.provider, 'cursor-local');
  assert.equal(explicit.source, 'explicit');
});

test('invalid preferences fail closed', () => {
  assert.throws(
    () => parseDelegationPreferencesV1({ implement: { provider: 'grok' }, owner: { provider: 'grok' } }),
    (error) => error.code === 'unknown_key',
  );
  assert.throws(
    () => parseDelegationPreferencesV1({ implement: { model: 'grok-4' } }),
    (error) => error.code === 'missing_key',
  );
  assert.throws(
    () => resolveAssignmentPreferenceV1({ role: 'implement' }, parseDelegationPreferencesV1(undefined), 'run_request.assignments[0]'),
    (error) => error.code === 'missing_key',
  );
});

test('unknown preferred providers become honest attention instead of a substitute slot', () => {
  const parsed = parseDelegationPreferencesV1({ implement: { provider: 'claude' } });
  assert.equal(parsed.attention.code, 'preferred_provider_unavailable');
  assert.equal(parsed.attention.items[0].provider, 'claude');
  const inspected = inspectDelegationPreferencesV1({
    run_id: 'vale-hardening',
    repo: '/tmp/repo',
    objective: 'Implement the slice.',
    preferences: { implement: { provider: 'claude' } },
    assignments: [{
      assignment_id: 'social-implementation',
      role: 'implement',
      prompt: 'Implement the slice.',
    }],
  });
  assert.equal(inspected.attention.code, 'preferred_provider_unavailable');
  assert.deepEqual(inspected.resolved, []);
});
