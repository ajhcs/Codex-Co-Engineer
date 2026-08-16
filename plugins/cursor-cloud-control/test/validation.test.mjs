import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InputError,
  assertSafeArtifactPath,
  assertSafeRelativeDestination,
  validateToolInput,
} from '../mcp/validation.mjs';

const agentId = 'bc-00000000-0000-0000-0000-000000000001';
const runId = 'run-00000000-0000-0000-0000-000000000001';

test('create requires a stable request ID, usage permits an omitted run ID, and actions reject foreign fields', () => {
  assert.throws(
    () => validateToolInput('agents', { action: 'create', prompt: { text: 'plan this' } }),
    /requestId is required/,
  );
  const create = validateToolInput('agents', { action: 'create', requestId: 'create-plan-1', prompt: { text: 'plan this' } });
  assert.equal(create.action, 'create');
  assert.throws(
    () => validateToolInput('runs', { action: 'followup', agentId, prompt: { text: 'continue' } }),
    /requestId is required/,
  );
  assert.equal(validateToolInput('usage', { agentId }).runId, undefined);
  assert.throws(() => validateToolInput('agents', { action: 'list', prompt: { text: 'not allowed' } }), InputError);
  assert.throws(() => validateToolInput('runs', { action: 'get', agentId, runId, timeoutMs: 1000 }), InputError);
});

test('write-mode repository dispatch requires an immutable start commit', () => {
  assert.throws(() => validateToolInput('agents', {
    action: 'create', requestId: 'create-agent-1', mode: 'agent', prompt: { text: 'implement' },
    repos: [{ url: 'https://github.com/acme/project', startingRef: 'main' }],
  }), /immutable/);
  const value = validateToolInput('agents', {
    action: 'create', requestId: 'create-agent-2', mode: 'agent', prompt: { text: 'implement' },
    repos: [{ url: 'https://github.com/acme/project', startingRef: '0123456789012345678901234567890123456789' }],
  });
  assert.equal(value.mode, 'agent');
  const customModel = validateToolInput('agents', {
    action: 'create', requestId: 'create-agent-3', prompt: { text: 'delegate' },
    customSubagents: [{ name: 'review', description: 'Review changes', prompt: 'Review the patch', model: 'composer-2' }],
  });
  assert.equal(customModel.customSubagents[0].model, 'composer-2');
});

test('sensitive MCP headers and unsafe destinations are rejected', () => {
  assert.throws(() => validateToolInput('agents', {
    action: 'create', requestId: 'create-agent-4', prompt: { text: 'use a server' },
    mcpServers: [{ name: 'remote', type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer hidden-value' } }],
  }), /credential-bearing/);
  assert.throws(() => assertSafeArtifactPath('artifacts/../secret.txt'), /unsafe/);
  assert.throws(() => assertSafeRelativeDestination('../outside.txt'), /unsafe/);
  assert.equal(assertSafeArtifactPath('artifacts/log.txt'), 'artifacts/log.txt');
});

test('delete confirmation is tied exactly to the target ID', () => {
  assert.throws(() => validateToolInput('lifecycle', { action: 'delete', agentId, confirmation: agentId }), /exactly/);
  const value = validateToolInput('lifecycle', { action: 'delete', agentId, confirmation: `delete:${agentId}` });
  assert.equal(value.confirmation, `delete:${agentId}`);
  assert.equal(validateToolInput('runs', { action: 'get', agentId, runId }).runId, runId);
});
