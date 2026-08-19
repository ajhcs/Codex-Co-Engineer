import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildGrokArgs,
  grokBuildFinalResponse,
  grokCapabilityProfile,
  grokBuildFailure,
  grokVersionProbe,
  GROK_REASONING_EFFORTS,
  GROK_READ_ONLY_PERMISSION_MODE,
  normalizeGrokConfiguration,
  GROK_READ_ONLY_MCP_DENY_RULE,
} from '../mcp/grok-build.mjs';

test('Grok reasoning values match the installed 1.0.4 CLI contract', () => {
  assert.deepEqual(GROK_REASONING_EFFORTS, ['low', 'medium', 'high', 'xhigh']);
  assert.throws(
    () => normalizeGrokConfiguration({ reasoning_effort: 'minimal' }, 'verify'),
    /reasoning_effort must be one of low, medium, high, xhigh/,
  );
});

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
  for (const role of ['review', 'verify']) {
    for (const requested of [undefined, 'default', 'plan', 'auto']) {
      const input = requested === undefined ? {} : { permission_mode: requested };
      const normalized = normalizeGrokConfiguration(input, role);
      assert.equal(normalized.sandbox_profile, 'read-only');
      assert.equal(normalized.permission_mode, GROK_READ_ONLY_PERMISSION_MODE);
      assert.equal(normalized.permission_mode, 'auto');
      assert.deepEqual(buildGrokArgs({
        prompt: `review the bounded target (${role})`,
        cwd: '/tmp/target',
        configuration: normalized,
      }).slice(-6), ['--sandbox', 'read-only', '--permission-mode', 'auto', '--deny', GROK_READ_ONLY_MCP_DENY_RULE]);
      const profile = grokCapabilityProfile(input, role);
      assert.equal(profile.execution.permission_mode, 'auto');
      assert.equal(profile.execution.sandbox_profile, 'read-only');
    }
  }
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
    /automatic approval/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ no_plan: true }, 'review'),
    /connector-managed analysis policy/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ sandbox_profile: 'strict' }, 'verify'),
    /strict still permits CWD writes/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ output_format: 'plain' }, 'review'),
    /structured output format.*fail-closed/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ permission_mode: 'acceptEdits' }, 'review'),
    /write-capable approval modes are rejected/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ permission_mode: 'dontAsk' }, 'verify'),
    /write-capable approval modes are rejected/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ permission_mode: 'bypassPermissions' }, 'review'),
    /write-capable approval modes are rejected/,
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
    /explicit read-only tool rule/,
  );
  for (const rule of ['*', '**', 'Bash(*)', 'Edit(*)', 'Read(*) || Bash(*)']) {
    assert.throws(
      () => normalizeGrokConfiguration({ allow_rules: [rule] }, 'review'),
      /explicit read-only tool rule/,
    );
  }
  assert.deepEqual(
    normalizeGrokConfiguration({ allow_rules: ['Read(*)', 'Grep(src/**)'] }, 'verify').allow_rules,
    ['Read(*)', 'Grep(src/**)'],
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

test('Grok capability disclosure reports executable read-only policy without plan approval gating', () => {
  const review = grokCapabilityProfile({}, 'review');
  assert.deepEqual(review.execution, {
    final_response: true,
    target_workspace_write: 'requires_verified_read_only_sandbox_and_runner_check',
    permission_mode: 'auto',
    mcp_meta_tools: 'denied_for_review_verify',
    role: 'review',
    sandbox_profile: 'read-only',
  });
  const verify = grokCapabilityProfile({ permission_mode: 'plan' }, 'verify');
  assert.equal(verify.execution.permission_mode, 'auto');
  assert.equal(verify.execution.sandbox_profile, 'read-only');
  assert.equal(verify.execution.final_response, true);
  const implement = grokCapabilityProfile({}, 'implement');
  assert.equal(implement.execution.permission_mode, 'auto');
  assert.equal(implement.execution.sandbox_profile, 'workspace');
  assert.equal(implement.execution.target_workspace_write, 'bounded_by_target_contract');
});

test('Grok review policy denies MCP meta-tools and reports always-approve precedence', () => {
  assert.throws(
    () => normalizeGrokConfiguration({ allow_rules: ['MCPTool(linear__issues_create)'] }, 'review'),
    /cannot customize MCPTool permissions/,
  );
  assert.throws(
    () => normalizeGrokConfiguration({ deny_rules: ['MCPTool(*)'] }, 'verify'),
    /cannot customize MCPTool permissions/,
  );
  const implement = grokCapabilityProfile({ always_approve: true }, 'implement');
  assert.equal(implement.execution.permission_mode, 'auto');
  assert.equal(implement.execution.effective_permission_mode, 'bypassPermissions');
  assert.equal(implement.execution.approval_precedence, 'always_approve_overrides_auto');
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

test('Grok streaming parser classifies the final session outcome after blocked tool calls', () => {
  const recovered = [
    '{"type":"tool_call","toolCallId":"call_1","status":"in_progress","toolName":"run_terminal_cmd"}',
    '{"type":"tool_call_update","toolCallId":"call_1","status":"failed","rawOutput":{"error":"denied"}}',
    '{"type":"text","data":"I could not run that command, but the read-only review is complete."}',
    '{"type":"end","stopReason":"end_turn","sessionId":"abc"}',
  ].join('\n');
  assert.equal(grokBuildFailure(recovered), null);

  const recoveredWithoutEnd = [
    '{"type":"tool_call_update","status":"blocked","detail":"MCPTool denied"}',
    '{"type":"text","data":"Review complete."}',
  ].join('\n');
  assert.equal(grokBuildFailure(recoveredWithoutEnd), null);

  const terminalFailure = [
    '{"type":"tool_call_update","status":"blocked","detail":"MCPTool denied"}',
    '{"type":"end","stopReason":"error","message":"session failed"}',
  ].join('\n');
  assert.equal(grokBuildFailure(terminalFailure), 'session failed');
});

test('Grok streaming parser exposes only a bounded final assistant response', () => {
  const response = grokBuildFinalResponse([
    '{"type":"reasoning","text":"private chain of thought"}',
    '{"type":"tool_call","toolName":"Read","status":"completed"}',
    '{"type":"text","data":"Review "}',
    '{"type":"message","message":{"role":"assistant","content":"complete."}}',
    '{"type":"end","stopReason":"end_turn"}',
  ].join('\n'));
  assert.deepEqual(response, {
    text: 'Review complete.',
    truncated: false,
    characters: 16,
  });
  assert.equal(grokBuildFinalResponse('{"type":"reasoning","text":"not a report"}'), null);
  const bounded = grokBuildFinalResponse('{"type":"result","result":"abcdefghijkl"}', 5);
  assert.deepEqual(bounded, { text: 'abcd…', truncated: true, characters: 12 });
});

test('Grok streaming parser fails closed on sandbox fallback warnings', () => {
  assert.match(
    grokBuildFailure('warning: sandbox could not be applied; continuing without enforcement\n'),
    /sandbox enforcement was not proven/,
  );
  assert.match(
    grokBuildFailure('{"type":"text","data":"warning: sandbox failed to apply"}\n'),
    /sandbox enforcement was not proven/,
  );
});

test('Grok version probe distinguishes missing from installed without authentication', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-grok-version-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(grokVersionProbe('/definitely/missing/grok', directory).executable_state, 'missing');
  const installed = grokVersionProbe('/bin/true', directory);
  assert.equal(installed.executable_state, 'installed');
});
