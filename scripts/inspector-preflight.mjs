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
  const inspector = process.env.MCP_INSPECTOR_COMMAND ?? 'mcp-inspector';
  const result = spawnSync(inspector, [
    '--cli', 'node', 'plugins/plumbob-harness-control/mcp/server.mjs',
    '--method', 'tools/call', '--tool-name', 'preflight',
    '--tool-args-json', JSON.stringify(args), '--format', 'json',
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODEX_CO_ENGINEER_STATE_DIR: stateDirectory,
      CODEX_CO_ENGINEER_RUNTIME_WORKSPACE: workspace,
      PLUMBOB_HARNESS_DAEMON_IDLE_SECONDS: '1',
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  const callResult = envelope.result ?? envelope;
  const structured = callResult.structuredContent
    ?? JSON.parse(callResult.content?.[0]?.text ?? '{}');
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
