import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildGrokArgs,
  grokCapabilityProfile,
  grokBuildFailure,
  grokVersionProbe,
  normalizeGrokConfiguration,
} from '../mcp/grok-build.mjs';

test('Grok argv construction is deterministic and shell-free', () => {
  const configuration = normalizeGrokConfiguration({
    model: 'grok-4.6',
    output_format: 'streaming-json',
    session_id: '123e4567-e89b-12d3-a456-426614174000',
    reasoning_effort: 'high',
    max_turns: 12,
    sandbox_profile: 'workspace',
    permission_mode: 'auto',
    rules: 'Stay within the target.',
    allowed_tools: ['Read', 'Grep'],
    disallowed_tools: ['Bash'],
    allow_rules: ['Read'],
    deny_rules: ['Bash rm -rf *'],
    always_approve: false,
    no_auto_update: true,
    no_plan: true,
    no_subagents: true,
    no_memory: true,
    disable_web_search: true,
  }, 'implement');
  const prompt = 'Review $(touch /tmp/should-not-run) -- still one argv value';
  const args = buildGrokArgs({ prompt, cwd: '/tmp/target repo', configuration });
  assert.deepEqual(args, [
    '--no-auto-update', '-p', prompt, '--cwd', '/tmp/target repo', '--output-format', 'streaming-json',
    '-m', 'grok-4.6', '-s', '123e4567-e89b-12d3-a456-426614174000', '--reasoning-effort', 'high',
    '--max-turns', '12', '--sandbox', 'workspace', '--permission-mode', 'auto', '--rules', 'Stay within the target.',
    '--tools', 'Read,Grep', '--disallowed-tools', 'Bash', '--allow', 'Read', '--deny', 'Bash rm -rf *',
    '--no-plan', '--no-subagents', '--no-memory', '--disable-web-search',
  ]);
  assert.equal(args.filter((value) => value === prompt).length, 1);
});

test('Grok session fork, approval, sandbox, and feature flags map to the local 1.0.4 CLI', () => {
  const configuration = normalizeGrokConfiguration({
    output_format: 'streaming-messages-json',
    resume: true,
    fork_session: true,
    sandbox_profile: 'strict',
    permission_mode: 'auto',
    always_approve: true,
    no_auto_update: false,
    experimental_memory: true,
  }, 'implement');
  assert.deepEqual(buildGrokArgs({
    prompt: 'continue this bounded task',
    cwd: '/tmp/target',
    configuration,
  }), [
    '-p', 'continue this bounded task', '--cwd', '/tmp/target',
    '--output-format', 'streaming-messages-json', '--resume', '--fork-session',
    '--sandbox', 'strict', '--permission-mode', 'auto', '--always-approve',
    '--experimental-memory',
  ]);
});

test('Grok profile separates main-session agent selection from requested delegation policy', () => {
  const configuration = normalizeGrokConfiguration({
    agent: 'explore',
    delegation: { enabled: true },
  }, 'implement');
  assert.equal(configuration.no_subagents, false);
  assert.equal(configuration.agent, 'explore');
  assert.deepEqual(configuration.delegation, { enabled: true });
  assert.deepEqual(buildGrokArgs({
    prompt: 'inspect this bounded target',
    cwd: '/tmp/target',
    configuration,
  }).slice(0, 5), [
    '--no-auto-update', '--agent', 'explore', '-p', 'inspect this bounded target',
  ]);

  const disabled = normalizeGrokConfiguration({ delegation: { enabled: false } }, 'implement');
  assert.equal(disabled.no_subagents, true);
  assert.equal(disabled.delegation.enabled, false);
  const profile = grokCapabilityProfile({
    agent: 'explore',
    delegation: { enabled: true },
  }, 'implement');
  assert.deepEqual(profile.transport, { selected: 'direct-headless', acp: 'not_exposed' });
  assert.deepEqual(profile.main_session_profile, {
    selection: 'named',
    effective: 'unknown',
    resolution: 'grok_cli_project_user_or_bundled',
    custom_or_shadowed: 'possible',
    definition_paths: 'not_exposed',
    requested: 'explore',
  });
  assert.deepEqual(profile.delegation, {
    supported: true,
    modes: ['enabled', 'disabled'],
    enabled_by_default: true,
    custom_definitions: 'not_exposed',
    restriction_inheritance: 'connector_process_boundary',
    requested: 'enabled',
    effective: 'unknown',
  });
  assert.equal(grokCapabilityProfile({ delegation: { enabled: false } }, 'implement').delegation.requested, 'disabled');
  assert.equal(grokCapabilityProfile({ delegation: { enabled: false } }, 'implement').delegation.effective, 'unknown');
  assert.equal(grokCapabilityProfile().delegation.requested, 'cli-default');
  const detached = grokCapabilityProfile();
  detached.delegation.modes.push('invalid');
  assert.deepEqual(grokCapabilityProfile().delegation.modes, ['enabled', 'disabled']);

  assert.throws(
    () => normalizeGrokConfiguration({ agent: '/tmp/agent.md' }, 'implement'),
    /agent must be an agent name, not a path/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ delegation: { agent: 'explore' } }, 'implement'),
    /delegation\.agent is not supported/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ delegation: {} }, 'implement'),
    /delegation\.enabled is required/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ no_subagents: true, delegation: { enabled: true } }, 'implement'),
    /delegation\.enabled conflicts with no_subagents/,
  );

  const legacy = normalizeGrokConfiguration({}, 'implement');
  assert.equal(Object.hasOwn(legacy, 'agent'), false);
  assert.equal(Object.hasOwn(legacy, 'delegation'), false);
  assert.deepEqual(Object.keys(legacy).slice(-7), [
    'no_plan',
    'no_subagents',
    'no_memory',
    'disable_web_search',
    'experimental_memory',
    'fork_session',
    'role',
  ]);
});

test('Grok structured output and message flags map to bounded official CLI argv', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  };
  const structured = normalizeGrokConfiguration({
    json_schema: schema,
    verbatim: true,
  }, 'implement');
  assert.equal(structured.output_format, 'json');
  const booleanSchema = normalizeGrokConfiguration({ json_schema: false }, 'implement');
  assert.equal(booleanSchema.output_format, 'json');
  assert.deepEqual(buildGrokArgs({
    prompt: 'return a boolean',
    cwd: '/tmp/target',
    configuration: booleanSchema,
  }).slice(-6), [
    '--json-schema', 'false', '--sandbox', 'workspace', '--permission-mode', 'auto',
  ]);
  assert.deepEqual(buildGrokArgs({
    prompt: 'return a name',
    cwd: '/tmp/target',
    configuration: structured,
  }), [
    '--no-auto-update', '-p', 'return a name', '--cwd', '/tmp/target', '--output-format', 'json',
    '--json-schema', JSON.stringify(schema), '--verbatim', '--sandbox', 'workspace', '--permission-mode', 'auto',
  ]);

  const partial = normalizeGrokConfiguration({
    output_format: 'streaming-messages-json',
    include_partial_messages: true,
  }, 'implement');
  assert.deepEqual(buildGrokArgs({
    prompt: 'stream this task',
    cwd: '/tmp/target',
    configuration: partial,
  }), [
    '--no-auto-update', '-p', 'stream this task', '--cwd', '/tmp/target',
    '--output-format', 'streaming-messages-json', '--include-partial-messages',
    '--sandbox', 'workspace', '--permission-mode', 'auto',
  ]);
});

test('Grok session and role policy validation fails closed', () => {
  const reviewDefaults = normalizeGrokConfiguration({}, 'review');
  assert.equal(reviewDefaults.sandbox_profile, 'read-only');
  assert.equal(reviewDefaults.permission_mode, 'plan');
  const implementDefaults = normalizeGrokConfiguration({}, 'implement');
  assert.equal(implementDefaults.sandbox_profile, 'workspace');
  assert.equal(implementDefaults.permission_mode, 'auto');
  assert.throws(
    () => normalizeGrokConfiguration({ session_id: 'not-a-uuid' }, 'implement'),
    /session_id must be a valid UUID/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ session_id: '123e4567-e89b-12d3-a456-426614174000', resume: true }, 'implement'),
    /only when fork_session is true/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ session_id: '123e4567-e89b-12d3-a456-426614174000', resume: true, fork_session: true, continue_session: true }, 'implement'),
    /cannot be combined with continue_session/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ always_approve: true }, 'review'),
    /read-only roles/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ no_plan: true }, 'review'),
    /forced plan policy/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ sandbox_profile: 'strict' }, 'verify'),
    /strict still permits CWD writes/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ permission_mode: 'bypassPermissions' }, 'implement'),
    /cannot bypass/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ permission_mode: 'acceptEdits' }, 'implement'),
    /require auto/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ always_approve: null }, 'implement'),
    /always_approve must be a boolean/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ sandbox_profile: 'off' }, 'implement'),
    /cannot widen/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ allow_rules: ['Bash git status'] }, 'review'),
    /cannot allow write-capable/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ include_partial_messages: true }, 'implement'),
    /only valid with output_format=streaming-messages-json/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ output_format: 'streaming-json', json_schema: { type: 'object' } }, 'implement'),
    /must be json when json_schema is provided/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ json_schema: ['not', 'a', 'schema'] }, 'implement'),
    /JSON Schema object or boolean/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ json_schema: { description: 'x'.repeat(16_500) } }, 'implement'),
    /at most 16384 bytes/,
  );
  assert.throws(
    () => buildGrokArgs({ prompt: 'bad\u0000prompt', cwd: '/tmp/target', configuration: {} }),
    /unsupported control character/,
  );
});

test('Grok streaming parser ignores unknown and partial records but surfaces explicit errors', () => {
  assert.equal(grokBuildFailure([
    '{"type":"future_event","payload":{"text":"ok"}}',
    '{"type":"message","text":"done"}',
    '{"type":"partial',
  ].join('\n')), null);
  assert.equal(grokBuildFailure('{"type":"error","message":"unauthenticated"}\n'), 'unauthenticated');
  assert.equal(grokBuildFailure('{"status":"failed","reason":"tool denied"}\n'), 'tool denied');
  assert.equal(grokBuildFailure('{"status":"failure","detail":"provider unavailable"}\n'), 'provider unavailable');
});

test('Grok version probe distinguishes missing from installed without authentication', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-grok-version-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(grokVersionProbe('/definitely/missing/grok', directory).executable_state, 'missing');
  const installed = grokVersionProbe('/bin/true', directory);
  assert.equal(installed.executable_state, 'installed');
});
