import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { targetIdentityDigest } from '../mcp/preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function stopDaemon(socketFile) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketFile);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: 'test-shutdown', name: '__shutdown', args: {} })}\n`);
    });
    socket.once('error', reject);
    socket.once('data', () => {
      socket.end();
      resolve();
    });
  });
}

async function targetFixture(directory) {
  assert.equal(spawnSync('git', ['init', '-q', directory]).status, 0);
  await writeFile(path.join(directory, 'note.txt'), 'initial\n');
  assert.equal(spawnSync('git', ['-C', directory, 'add', 'note.txt']).status, 0);
  assert.equal(spawnSync('git', [
    '-C', directory,
    '-c', 'user.name=Codex-Co-Engineer Test',
    '-c', 'user.email=codex-co-engineer@example.invalid',
    'commit', '-qm', 'initial',
  ]).status, 0);
  const head = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const workspace = await realpath(directory);
  const common = await realpath(path.join(directory, '.git'));
  const identity = await stat(workspace);
  const fingerprint = targetIdentityDigest({
    mode: 'explicit',
    resolved_workspace: workspace,
    resolved_cwd: workspace,
    git_common_directory: common,
    git_head: head,
    workspace_identity: { device: String(identity.dev), inode: String(identity.ino) },
    cwd_identity: { device: String(identity.dev), inode: String(identity.ino) },
  });
  return {
    fingerprint,
    target: {
      schema_version: 'codex-co-engineer.target.v1',
      mode: 'explicit',
      working_directory: workspace,
      expected_git_root: workspace,
      expected_head: head,
      allowed_paths: ['.'],
      role: 'review',
    },
  };
}

test('MCP handshake exposes strict preflight identity and guarded status', async (context) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'plumbob-control-test-'));
  const targetDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-co-engineer-target-'));
  context.after(async () => Promise.all([
    rm(state, { recursive: true, force: true }),
    rm(targetDirectory, { recursive: true, force: true }),
  ]));
  const { target, fingerprint } = await targetFixture(targetDirectory);

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: { recent_limit: 0 } } },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'preflight',
        arguments: {
          schema_version: 'codex-co-engineer.config.v1',
          kind: 'preflight',
          target_context: target,
          expected_target_fingerprint: fingerprint,
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'run',
        arguments: {
          schema_version: 'codex-co-engineer.config.v1',
          kind: 'removed_backend',
          request_id: 'test-request-001',
          prompt: 'Do not actually run.',
          target_context: target,
          expected_target_fingerprint: fingerprint,
        },
      },
    },
  ];
  const { NODE_TEST_CONTEXT: _testContext, ...serverEnvironment } = process.env;
  const result = spawnSync(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs'), '--stdio'], {
    cwd: ROOT,
    env: {
      ...serverEnvironment,
      MODEL_API_KEY: '',
      CODEX_CO_ENGINEER_RUNTIME_WORKSPACE: targetDirectory,
      PLUMBOB_HARNESS_STATE_DIR: state,
      PLUMBOB_HARNESS_DAEMON_IDLE_SECONDS: '60',
      PLUMBOB_HARNESS_MODEL_API_KEY_FILE: path.join(state, 'missing-model-api-key'),
    },
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 15000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), JSON.stringify({
    error: result.error?.message ?? null,
    signal: result.signal,
    stderr: result.stderr,
  }));
  const responses = new Map(
    result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)).map((message) => [message.id, message]),
  );
  assert.equal(responses.get(1).result.serverInfo.name, 'plumbob-harness-control');
  assert.equal(responses.get(1).result.serverInfo.version, '2.0.0');
  assert.equal(responses.get(1).result.protocolVersion, '2025-11-25');
  assert.deepEqual(
    responses.get(2).result.tools.map((tool) => tool.name),
    ['preflight', 'status', 'runtime', 'run', 'jobs', 'cancel'],
  );
  const jobsTool = responses.get(2).result.tools.find((tool) => tool.name === 'jobs');
  assert.deepEqual(jobsTool.inputSchema.properties.action.enum, ['list', 'get', 'wait', 'logs']);
  assert.equal(jobsTool.inputSchema.properties.tail_lines.maximum, 120);

  const statusBody = JSON.parse(responses.get(3).result.content[0].text);
  assert.equal(statusBody.ok, true);
  assert.equal(statusBody.integration, 'control-only');
  assert.equal(statusBody.control_plane.health, 'healthy');
  assert.equal(statusBody.control_plane.version, '2.0.0');
  assert.ok(['administrator-allowlisted', 'explicit-target-any-git-root'].includes(statusBody.targeting.mode));
  assert.equal(statusBody.targeting.implement_targets, 'explicit-scoped-workspace');
  assert.equal(statusBody.ui.optional, true);
  assert.ok(statusBody.headless_agent);
  assert.equal(statusBody.credentials.model_api_key_available, false);
  assert.equal(statusBody.workspace.dsh_command, 'dsh');
  assert.equal(statusBody.grok_build.kind, 'grok_build');
  assert.equal(statusBody.grok_build.auth_state, 'unknown');

  const preflight = responses.get(4).result.structuredContent;
  assert.equal(preflight.target_fingerprint, fingerprint);
  assert.equal(preflight.resolved_workspace, targetDirectory);
  assert.equal(preflight.resolved_cwd, targetDirectory);
  assert.match(preflight.configuration_digest, /^[0-9a-f]{64}$/);
  assert.equal(preflight.transport, 'stdio');
  assert.equal(preflight.protocol_version, '2025-11-25');
  assert.deepEqual(preflight.server_identity, { name: 'plumbob-harness-control', version: '2.0.0' });
  assert.deepEqual(preflight.available_tools, ['preflight', 'status', 'runtime', 'run', 'jobs', 'cancel']);

  const denied = responses.get(5);
  assert.equal(denied.result.isError, true);
  assert.equal(JSON.parse(denied.result.content[0].text).code, 'invalid_kind');

  const runTool = responses.get(2).result.tools.find((tool) => tool.name === 'run');
  assert.deepEqual(runTool.inputSchema.properties.kind.enum, ['deepseek_agent', 'grok_build']);
  assert.deepEqual(
    runTool.inputSchema.properties.output_format.enum,
    ['plain', 'json', 'streaming-json', 'streaming-messages-json'],
  );
  assert.equal(runTool.inputSchema.properties.verbatim.type, 'boolean');
  assert.equal(runTool.inputSchema.properties.include_partial_messages.type, 'boolean');
  assert.deepEqual(
    runTool.inputSchema.properties.json_schema.oneOf.map((schema) => schema.type),
    ['boolean', 'object'],
  );

  await stopDaemon(path.join(state, 'control.sock'));
});
