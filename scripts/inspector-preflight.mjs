#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { targetIdentityDigest } from '../plugins/plumbob-harness-control/mcp/preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-co-engineer-inspector-target-'));
const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-co-engineer-inspector-state-'));
const inspector = process.env.MCP_INSPECTOR_COMMAND ?? 'mcp-inspector';
const inspectorEnvironment = {
  ...process.env,
  CODEX_CO_ENGINEER_STATE_DIR: stateDirectory,
  CODEX_CO_ENGINEER_RUNTIME_WORKSPACE: targetDirectory,
  PLUMBOB_HARNESS_DAEMON_IDLE_SECONDS: '60',
};

function inspect(method, toolName, toolArguments, { allowToolError = false } = {}) {
  const argumentsList = [
    '--cli', 'node', 'plugins/plumbob-harness-control/mcp/server.mjs',
    '--method', method,
  ];
  if (toolName) argumentsList.push('--tool-name', toolName);
  if (toolArguments !== undefined) argumentsList.push('--tool-args-json', JSON.stringify(toolArguments));
  const result = spawnSync(inspector, [...argumentsList, '--format', 'json'], {
    cwd: ROOT,
    env: inspectorEnvironment,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (allowToolError) {
    assert.ok([0, 5].includes(result.status), result.stderr || result.stdout);
  } else {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}

function callResult(envelope) {
  return envelope.result ?? envelope;
}

function structuredResult(envelope) {
  const result = callResult(envelope);
  return result.structuredContent
    ?? JSON.parse(result.content?.[0]?.text ?? '{}');
}

try {
  assert.equal(spawnSync('git', ['init', '-q', targetDirectory]).status, 0);
  await writeFile(path.join(targetDirectory, 'fixture.txt'), 'preflight\n');
  assert.equal(spawnSync('git', ['-C', targetDirectory, 'add', 'fixture.txt']).status, 0);
  assert.equal(spawnSync('git', [
    '-C', targetDirectory,
    '-c', 'user.name=Codex-Co-Engineer CI',
    '-c', 'user.email=codex-co-engineer@example.invalid',
    'commit', '-qm', 'fixture',
  ]).status, 0);
  const workspace = await realpath(targetDirectory);
  const common = await realpath(path.join(targetDirectory, '.git'));
  const head = spawnSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const identity = await stat(workspace);
  const fingerprint = targetIdentityDigest({
    mode: 'explicit', resolved_workspace: workspace, resolved_cwd: workspace,
    git_common_directory: common, git_head: head,
    workspace_identity: { device: String(identity.dev), inode: String(identity.ino) },
    cwd_identity: { device: String(identity.dev), inode: String(identity.ino) },
  });
  const args = {
    schema_version: 'codex-co-engineer.config.v1',
    kind: 'preflight',
    target_context: {
      schema_version: 'codex-co-engineer.target.v1', mode: 'explicit',
      working_directory: workspace, expected_git_root: workspace,
      expected_head: head, allowed_paths: ['.'], role: 'review',
    },
    expected_target_fingerprint: fingerprint,
  };
  inspectorEnvironment.CODEX_CO_ENGINEER_RUNTIME_WORKSPACE = workspace;

  const listEnvelope = inspect('tools/list');
  const tools = callResult(listEnvelope).tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['preflight', 'status', 'runtime', 'run', 'jobs', 'cancel']);
  const runTool = tools.find((tool) => tool.name === 'run');
  const kindPolicy = runTool.inputSchema.allOf.find((policy) => policy.if?.properties?.kind?.const === 'grok_build');
  assert.ok(kindPolicy, 'run schema must gate Grok fields by kind=grok_build');
  assert.equal(kindPolicy.then.if.properties.target_context.required[0], 'role');
  assert.equal(kindPolicy.then.then.properties.permission_mode.const, 'auto');
  assert.deepEqual(kindPolicy.then.then.properties.sandbox_profile.enum, ['workspace', 'read-only', 'strict']);
  assert.deepEqual(kindPolicy.then.else.properties.permission_mode.enum, ['default', 'plan']);
  assert.equal(kindPolicy.then.else.properties.sandbox_profile.const, 'read-only');
  assert.equal(kindPolicy.then.else.properties.always_approve.const, false);
  assert.equal(kindPolicy.then.else.properties.no_plan.const, false);
  const readOnlyToolPattern = new RegExp(kindPolicy.then.else.properties.allowed_tools.items.pattern);
  for (const tool of ['Read', 'Grep', 'Glob', 'LS', 'Find', 'WebFetch', 'WebSearch']) {
    assert.match(tool, readOnlyToolPattern);
  }
  for (const tool of ['Write', 'Edit', 'Bash']) {
    assert.doesNotMatch(tool, readOnlyToolPattern);
  }
  const forbiddenFields = kindPolicy.else.not.anyOf.flatMap((schema) => schema.required);
  assert.ok(forbiddenFields.includes('permission_mode'));
  assert.ok(forbiddenFields.includes('model'));

  const envelope = inspect('tools/call', 'preflight', args);
  const structured = structuredResult(envelope);
  for (const field of [
    'target_fingerprint', 'resolved_workspace', 'resolved_cwd',
    'configuration_digest', 'transport', 'protocol_version',
    'server_identity', 'available_tools',
  ]) assert.ok(structured[field], `missing preflight field ${field}`);
  assert.equal(structured.target_fingerprint, fingerprint);
  assert.equal(structured.resolved_workspace, workspace);
  assert.equal(structured.resolved_cwd, workspace);
  assert.equal(structured.transport, 'stdio');
  assert.equal(structured.protocol_version, '2025-11-25');
  assert.equal(structured.server_identity.name, 'plumbob-harness-control');
  assert.ok(structured.available_tools.includes('preflight'));

  const grokImplementTarget = { ...args.target_context, role: 'implement' };
  const grokImplementOmitted = structuredResult(inspect('tools/call', 'preflight', {
    ...args,
    kind: 'grok_build',
    target_context: grokImplementTarget,
  }));
  assert.notEqual(grokImplementOmitted.code, 'invalid_argument');
  const grokImplementAuto = structuredResult(inspect('tools/call', 'preflight', {
    ...args,
    kind: 'grok_build',
    target_context: grokImplementTarget,
    permission_mode: 'auto',
  }));
  assert.notEqual(grokImplementAuto.code, 'invalid_argument');

  const deepseekPermission = callResult(inspect('tools/call', 'preflight', {
    ...args,
    kind: 'deepseek_agent',
    permission_mode: 'auto',
  }, { allowToolError: true }));
  assert.equal(deepseekPermission.isError, true);
  assert.equal(JSON.parse(deepseekPermission.content[0].text).code, 'invalid_argument');
  const deepseekModel = callResult(inspect('tools/call', 'preflight', {
    ...args,
    kind: 'deepseek_agent',
    model: 'grok-4.6',
  }, { allowToolError: true }));
  assert.equal(deepseekModel.isError, true);
  assert.equal(JSON.parse(deepseekModel.content[0].text).code, 'invalid_argument');
  process.stdout.write(`${JSON.stringify(structured, null, 2)}\n`);

  await new Promise((resolve) => {
    const socket = net.createConnection(path.join(stateDirectory, 'control.sock'));
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'shutdown', name: '__shutdown', args: {} })}\n`));
    socket.on('data', () => { socket.end(); resolve(); });
    socket.on('error', resolve);
  });
} finally {
  await Promise.all([
    rm(targetDirectory, { recursive: true, force: true }),
    rm(stateDirectory, { recursive: true, force: true }),
  ]);
}
